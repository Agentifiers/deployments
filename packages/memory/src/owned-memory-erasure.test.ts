import { describe, expect, test } from "bun:test";
import {
  MemoryRecord,
  Ulid,
  withCanonicalRecordKeys,
  type DynamoDatabaseService,
} from "@deployments-ai/db";
import { Schema } from "effect";
import type { MemorySearchProviderClient } from "./provider.ts";
import { purgeOwnedMemories } from "./owned-memory-erasure.ts";

const values = "0123456789"
  .split("")
  .map((suffix) => Schema.decodeUnknownSync(Ulid)(`01ARZ3NDEKTSV4RRFFQ69G5FA${suffix}`));
const [
  organizationId,
  brainId,
  operationId,
  memoryId,
  memorySpaceId,
  documentId,
  versionId,
  renditionId,
  sourceId,
  targetId,
] = values;
const timestamp = "2026-07-31T00:00:00.000Z";

function memory(threadId?: Ulid) {
  return Schema.decodeUnknownSync(MemoryRecord)(
    withCanonicalRecordKeys({
      data: {
        body: "Derived confidential knowledge",
        ...(threadId ? { threadId } : {}),
        brainProvenance: [
          {
            brainId,
            chunkId: "chunk-1",
            documentId,
            documentVersionId: versionId,
            renditionId,
            sourceId,
          },
        ],
        contentHash: "sha256:content",
        createdAt: timestamp,
        environmentId: documentId,
        id: memoryId,
        memorySpaceId,
        organizationId,
        projectId: sourceId,
        reviewStatus: "approved" as const,
        scope: "organization" as const,
        searchKey: `organization:${organizationId}`,
        sensitivity: "confidential" as const,
        source: "agent",
        status: "active" as const,
        updatedAt: timestamp,
        version: 0,
      },
      itemType: "memory" as const,
    }),
  );
}

describe("owned memory erasure", () => {
  test("writes a higher-generation content-free tombstone to every unique provider target", async () => {
    const canonical = memory();
    const deleted: number[] = [];
    const provider = {
      delete: async ({
        synchronizationGeneration,
      }: {
        readonly synchronizationGeneration: number;
      }) => {
        deleted.push(synchronizationGeneration);
        return { status: "synchronized" as const };
      },
      providerId: "aws-native",
      target: { targetId },
    } as unknown as MemorySearchProviderClient;
    const database = {
      getRecord: async () => canonical,
    } as unknown as DynamoDatabaseService;

    const receipt = await purgeOwnedMemories({
      owner: { brainId: brainId!, kind: "brain" },
      database,
      memories: [{ pk: canonical.pk, sk: canonical.sk }],
      now: () => new Date(timestamp),
      operationId: operationId!,
      organizationId: organizationId!,
      resolvePlacement: async () => ({
        placementGeneration: 1,
        read: provider,
        writes: [provider],
      }),
    });

    expect(deleted).toEqual([Date.parse(timestamp) * 1_000 + 999]);
    expect(receipt.targets).toEqual([
      { contentPurged: true, memoryCount: 1, providerId: "aws-native", targetId: targetId! },
    ]);
  });

  test("fails before provider mutation when canonical provenance no longer matches", async () => {
    const canonical = memory();
    const database = {
      getRecord: async () => canonical,
    } as unknown as DynamoDatabaseService;
    expect(
      purgeOwnedMemories({
        database,
        memories: [{ pk: canonical.pk, sk: canonical.sk }],
        operationId: operationId!,
        organizationId: organizationId!,
        owner: { brainId: operationId!, kind: "brain" },
        resolvePlacement: async () => {
          throw new Error("provider resolution must not run");
        },
      }),
    ).rejects.toThrow("changed or crossed");
  });

  test("tombstones a memory formed in the erased thread and refuses another thread's", async () => {
    const canonical = memory(sourceId);
    const deleted: string[] = [];
    const provider = {
      delete: async ({ memory: target }: { readonly memory: { readonly sk: string } }) => {
        deleted.push(target.sk);
        return { status: "synchronized" as const };
      },
      providerId: "aws-native",
      target: { targetId },
    } as unknown as MemorySearchProviderClient;
    const database = { getRecord: async () => canonical } as unknown as DynamoDatabaseService;
    const purge = (threadId: Ulid) =>
      purgeOwnedMemories({
        database,
        memories: [{ pk: canonical.pk, sk: canonical.sk }],
        now: () => new Date(timestamp),
        operationId: operationId!,
        organizationId: organizationId!,
        owner: { kind: "thread", threadId },
        resolvePlacement: async () => ({ placementGeneration: 1, read: provider, writes: [] }),
      });

    expect(await purge(sourceId!)).toEqual({
      operationId: operationId!,
      targets: [
        { contentPurged: true, memoryCount: 1, providerId: "aws-native", targetId: targetId! },
      ],
      threadId: sourceId!,
    });
    expect(deleted).toEqual([canonical.sk]);
    expect(purge(documentId!)).rejects.toThrow("changed or crossed");
  });
});
