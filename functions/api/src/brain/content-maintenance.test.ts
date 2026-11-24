import { describe, expect, test } from "bun:test";
import { DeleteObjectsCommand, ListObjectVersionsCommand } from "@aws-sdk/client-s3";
import {
  BrainContentCleanupRecord,
  withCanonicalRecordKeys,
  type DynamoDatabaseService,
  type PlatformRecord,
} from "@deployments-ai/db";
import { Schema } from "effect";
import { maintainBrainContent } from "./content-maintenance.ts";

const organizationId = "01ARZ3NDEKTSV4RRFFQ69G5FA1";
const brainId = "01ARZ3NDEKTSV4RRFFQ69G5FA2";
const cleanupId = "01ARZ3NDEKTSV4RRFFQ69G5FA3";
const startedAt = new Date("2026-07-31T12:00:00.000Z");
type CleanupRecord = Extract<PlatformRecord, { readonly itemType: "brain-content-cleanup" }>;

function cleanupRecord() {
  return Schema.decodeUnknownSync(BrainContentCleanupRecord)(
    withCanonicalRecordKeys({
      data: {
        brainId,
        bucket: "content-bucket",
        createdAt: startedAt.toISOString(),
        id: cleanupId,
        nextDueAt: startedAt.toISOString(),
        objectKey: `organizations/${organizationId}/brains/${brainId}/orphan`,
        organizationId,
        reason: "test-orphan",
        status: "pending" as const,
        updatedAt: startedAt.toISOString(),
        verificationCount: 0,
        version: 0,
      },
      itemType: "brain-content-cleanup" as const,
    }),
  );
}

function storage() {
  let cleanup: CleanupRecord | undefined = cleanupRecord();
  const writes: unknown[][] = [];
  const database = {
    deleteRecord: async () => {},
    getRecord: ((table, recordKey) =>
      Promise.resolve(
        table === "execution" && cleanup?.pk === recordKey.pk && cleanup?.sk === recordKey.sk
          ? cleanup
          : undefined,
      )) as DynamoDatabaseService["getRecord"],
    putRecord: async () => {},
    queryRecords: ((table, request) => {
      const partition = request.ExpressionAttributeValues?.[":pk"];
      return Promise.resolve({
        items: table === "execution" && cleanup?.gsi1pk === partition ? [cleanup] : [],
      });
    }) as DynamoDatabaseService["queryRecords"],
    transactWrite: (async (operations) => {
      writes.push(operations as unknown[]);
      for (const operation of operations) {
        if (operation.kind === "put" && operation.record.itemType === "brain-content-cleanup") {
          cleanup = operation.record as CleanupRecord;
        }
        if (operation.kind === "delete" && operation.record.itemType === "brain-content-cleanup") {
          cleanup = undefined;
        }
      }
    }) as DynamoDatabaseService["transactWrite"],
  } as unknown as DynamoDatabaseService;
  return {
    database,
    get cleanup() {
      return cleanup;
    },
    writes,
  };
}

describe("Brain content maintenance", () => {
  test("deletes every exact object version and requires two quiescent empty scans", async () => {
    const state = storage();
    let lists = 0;
    const deleted: unknown[] = [];
    const s3 = {
      send: async (command: unknown) => {
        if (command instanceof ListObjectVersionsCommand) {
          lists += 1;
          return lists === 1
            ? {
                DeleteMarkers: [{ Key: state.cleanup?.data.objectKey, VersionId: "delete-1" }],
                Versions: [{ Key: state.cleanup?.data.objectKey, VersionId: "version-1" }],
              }
            : {};
        }
        if (command instanceof DeleteObjectsCommand) {
          deleted.push(...(command.input.Delete?.Objects ?? []));
          return {};
        }
        throw new Error("Unexpected S3 command.");
      },
    };
    const run = (now: Date) =>
      maintainBrainContent({
        bucket: "content-bucket",
        database: state.database,
        generateId: async () => "01ARZ3NDEKTSV4RRFFQ69G5FA4",
        now,
        s3,
      });

    expect(run(startedAt)).resolves.toEqual({ cleaned: 1, expired: 0 });
    expect(deleted).toEqual([
      { Key: state.cleanup?.data.objectKey, VersionId: "version-1" },
      { Key: state.cleanup?.data.objectKey, VersionId: "delete-1" },
    ]);
    expect(state.cleanup?.data).toMatchObject({ status: "deleting", verificationCount: 0 });

    await run(new Date(startedAt.getTime() + 5 * 60_000));
    expect(state.cleanup?.data).toMatchObject({ status: "deleting", verificationCount: 1 });

    await run(new Date(startedAt.getTime() + 10 * 60_000));
    expect(state.cleanup).toBeUndefined();
    expect(lists).toBe(3);
  });
});
