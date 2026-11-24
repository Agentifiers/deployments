import { describe, expect, it } from "bun:test";
import { Effect, Exit, Schema } from "effect";
import { Ulid } from "./ids.ts";
import { decodePlatformRecord, withCanonicalRecordKeys } from "./records/index.ts";

const ID = Schema.decodeUnknownSync(Ulid)("01ARZ3NDEKTSV4RRFFQ69G5FAV");
const TARGET = Schema.decodeUnknownSync(Ulid)("01ARZ3NDEKTSV4RRFFQ69G5FAW");
const PROFILE = Schema.decodeUnknownSync(Ulid)("01ARZ3NDEKTSV4RRFFQ69G5FAY");
const COMPONENT = Schema.decodeUnknownSync(Ulid)("01ARZ3NDEKTSV4RRFFQ69G5FAZ");
const timestamp = "2026-07-28T12:00:00.000Z";

const target = {
  componentIds: [COMPONENT],
  embeddingProfileId: PROFILE,
  location: { region: "us-east-2" },
  providerId: "aws-native" as const,
  schemaGeneration: 1,
  targetId: TARGET,
};

describe("memory search records", () => {
  it("globally keys exclusive physical-component ownership", async () => {
    const physicalLocationHash = "a".repeat(64);
    const record = withCanonicalRecordKeys({
      data: {
        componentKind: "dense" as const,
        componentId: COMPONENT,
        createdAt: timestamp,
        organizationId: ID,
        physicalLocationHash,
        referenceCount: 1,
        targetId: TARGET,
        updatedAt: timestamp,
        version: 0,
      },
      itemType: "memory-search-physical-owner" as const,
    });
    expect(record.pk).toBe(`MEMORY-SEARCH-PHYSICAL-OWNER#${physicalLocationHash}`);
    expect(Exit.isSuccess(await Effect.runPromiseExit(decodePlatformRecord(record)))).toBe(true);
  });

  it("globally keys immutable target identities", async () => {
    const record = withCanonicalRecordKeys({
      data: {
        createdAt: timestamp,
        identityHash: "b".repeat(64),
        targetId: TARGET,
        updatedAt: timestamp,
        version: 0,
      },
      itemType: "memory-search-target-identity" as const,
    });
    expect(record.pk).toBe(`MEMORY-SEARCH-TARGET-IDENTITY#${TARGET}`);
    expect(Exit.isSuccess(await Effect.runPromiseExit(decodePlatformRecord(record)))).toBe(true);
  });

  it("keeps the optional backup boundary on pseudonymous erasure target receipts", async () => {
    const receipt = (boundary: Readonly<Record<string, string>>) =>
      withCanonicalRecordKeys({
        data: {
          acceptedAt: timestamp,
          ...boundary,
          componentReceipts: [
            {
              componentId: COMPONENT,
              providerReceipt: { absenceVerified: true, receiptDigest: "d" },
            },
          ],
          createdAt: timestamp,
          generationId: PROFILE,
          id: ID,
          keyVersion: 1,
          targetDigest: "target-digest",
          updatedAt: timestamp,
          version: 0,
        },
        itemType: "memory-erasure-target-receipt" as const,
      });
    const decode = (record: ReturnType<typeof receipt>) =>
      Effect.runPromiseExit(decodePlatformRecord(record));

    const withBoundary = await decode(
      receipt({ backupErasureEligibleAt: "2026-08-11T13:00:00.000Z" }),
    );
    const legacy = await decode(receipt({}));

    expect(Exit.isSuccess(withBoundary) && withBoundary.value.data).toMatchObject({
      backupErasureEligibleAt: "2026-08-11T13:00:00.000Z",
    });
    expect(Exit.isSuccess(legacy) && Object.keys(legacy.value.data).sort()).toEqual([
      "acceptedAt",
      "componentReceipts",
      "createdAt",
      "generationId",
      "id",
      "keyVersion",
      "targetDigest",
      "updatedAt",
      "version",
    ]);
    expect(
      Exit.isFailure(await decode(receipt({ backupErasureEligibleAt: "2026-08-11T13:00Z" }))),
    ).toBe(true);
  });

  it("keys target-specific index state independently", async () => {
    const record = withCanonicalRecordKeys({
      data: {
        attemptId: "attempt-1",
        contentHash: "sha256:memory",
        createdAt: timestamp,
        environmentId: ID,
        memoryId: ID,
        namespace: "memory-v1",
        organizationId: ID,
        projectId: ID,
        provider: "aws-native" as const,
        status: "ready" as const,
        synchronizationGeneration: 7,
        synchronizedVersion: 3,
        targetId: TARGET,
        updatedAt: timestamp,
        version: 0,
      },
      itemType: "memory-index-state" as const,
    });
    expect(record.sk).toBe(`MEMORY-INDEX-STATE#${TARGET}`);
    expect(record.gsi2pk).toBe(`MEMORY-SEARCH-TARGET#${TARGET}`);
    expect(Exit.isSuccess(await Effect.runPromiseExit(decodePlatformRecord(record)))).toBe(true);
  });

  it("indexes terminal jobs and queued shadows by physical target", async () => {
    const job = withCanonicalRecordKeys({
      data: {
        attempt: 1,
        createdAt: timestamp,
        environmentId: ID,
        expectedContentHash: "sha256:memory",
        expectedMemoryVersion: 1,
        id: PROFILE,
        idempotencyKey: "target-job",
        memoryId: COMPONENT,
        operation: "index" as const,
        organizationId: ID,
        projectId: ID,
        provider: "aws-native" as const,
        status: "succeeded" as const,
        synchronizationGeneration: 1,
        targetId: TARGET,
        updatedAt: timestamp,
        version: 1,
      },
      itemType: "memory-index-job" as const,
    });
    const shadow = withCanonicalRecordKeys({
      data: {
        createdAt: timestamp,
        environmentId: ID,
        expiresAt: "2026-07-29T12:00:00.000Z",
        id: PROFILE,
        input: {
          memorySpaceIds: [COMPONENT],
          query: "provider evidence",
          shadow: true as const,
          shadowAttemptId: PROFILE,
          shadowOfAttemptId: ID,
          strategyOverride: "dense-v1" as const,
          targetId: TARGET,
        },
        organizationId: ID,
        projectId: ID,
        targetId: TARGET,
        version: 0,
      },
      itemType: "memory-shadow-job" as const,
      ttl: Math.floor(Date.parse("2026-07-29T12:00:00.000Z") / 1_000),
    });

    expect(job.gsi2pk).toBe(`MEMORY-SEARCH-TARGET#${TARGET}`);
    expect(job.gsi1pk).toBeUndefined();
    expect(shadow.gsi1pk).toBe(`MEMORY-SEARCH-TARGET#${TARGET}`);
    expect(Exit.isSuccess(await Effect.runPromiseExit(decodePlatformRecord(job)))).toBe(true);
    expect(Exit.isSuccess(await Effect.runPromiseExit(decodePlatformRecord(shadow)))).toBe(true);
  });

  it("projects only retryable index jobs into due-work recovery", () => {
    const job = withCanonicalRecordKeys({
      data: {
        attempt: 1,
        createdAt: timestamp,
        environmentId: ID,
        expectedContentHash: "sha256:memory",
        expectedMemoryVersion: 1,
        id: PROFILE,
        idempotencyKey: "target-job",
        memoryId: COMPONENT,
        nextDueAt: timestamp,
        operation: "index" as const,
        organizationId: ID,
        projectId: ID,
        provider: "aws-native" as const,
        status: "failed" as const,
        synchronizationGeneration: 1,
        targetId: TARGET,
        updatedAt: timestamp,
        version: 1,
      },
      itemType: "memory-index-job" as const,
    });

    expect(job.gsi1pk).toMatch(/^QUEUE#MEMORY-INDEX-JOB#failed#/);
    expect(job.gsi2pk).toBe(`MEMORY-SEARCH-TARGET#${TARGET}`);
  });

  it("rejects serving placement phases without a read target", async () => {
    const record = withCanonicalRecordKeys({
      data: {
        createdAt: timestamp,
        generation: 1,
        organizationId: ID,
        phase: "active" as const,
        updatedAt: timestamp,
        version: 1,
        writeTargets: [target],
      },
      itemType: "memory-search-placement" as const,
    });
    expect(Exit.isFailure(await Effect.runPromiseExit(decodePlatformRecord(record)))).toBe(true);
  });

  it("accepts an explicit active AWS-native placement", async () => {
    const record = withCanonicalRecordKeys({
      data: {
        createdAt: timestamp,
        generation: 2,
        organizationId: ID,
        phase: "active" as const,
        readTarget: target,
        updatedAt: timestamp,
        version: 2,
        writeTargets: [target],
      },
      itemType: "memory-search-placement" as const,
    });
    expect(record.sk).toBe(`MEMORY-SEARCH-PLACEMENT#${ID}`);
    expect(Exit.isSuccess(await Effect.runPromiseExit(decodePlatformRecord(record)))).toBe(true);
  });

  it("rejects a serving placement whose read target is not writable", async () => {
    const record = withCanonicalRecordKeys({
      data: {
        createdAt: timestamp,
        generation: 2,
        organizationId: ID,
        phase: "active" as const,
        readTarget: target,
        updatedAt: timestamp,
        version: 2,
        writeTargets: [{ ...target, targetId: ID }],
      },
      itemType: "memory-search-placement" as const,
    });
    expect(Exit.isFailure(await Effect.runPromiseExit(decodePlatformRecord(record)))).toBe(true);
  });
});
