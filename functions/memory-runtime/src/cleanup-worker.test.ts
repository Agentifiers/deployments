import { describe, expect, it } from "bun:test";
import { handleMemoryCleanupQueue } from "./cleanup-worker.ts";
describe("memory cleanup worker", () => {
  it("scrubs review content through the durable cleanup queue", async () => {
    const calls: unknown[] = [];
    const result = await handleMemoryCleanupQueue(
      {
        Records: [
          {
            body: JSON.stringify({
              detail: {
                environmentId: "01ARZ3NDEKTSV4RRFFQ69G5FA2",
                memoryId: "01ARZ3NDEKTSV4RRFFQ69G5FA3",
                operation: "review-content-cleanup",
                organizationId: "01ARZ3NDEKTSV4RRFFQ69G5FA5",
                projectId: "01ARZ3NDEKTSV4RRFFQ69G5FA6",
              },
            }),
            messageId: "cleanup-review-1",
          },
        ],
      },
      {
        platform: {
          scrubMemoryReviewContent: async (...args: unknown[]) => {
            calls.push(args);
          },
        } as never,
      },
    );

    expect(result).toEqual({ batchItemFailures: [] });
    expect(calls).toEqual([
      [
        {
          environmentId: "01ARZ3NDEKTSV4RRFFQ69G5FA2",
          organizationId: "01ARZ3NDEKTSV4RRFFQ69G5FA5",
          projectId: "01ARZ3NDEKTSV4RRFFQ69G5FA6",
        },
        "01ARZ3NDEKTSV4RRFFQ69G5FA3",
      ],
    ]);
  });

  it("deletes blobs without initializing the model or search runtime", async () => {
    const deleted: unknown[] = [];
    const result = await handleMemoryCleanupQueue(
      {
        Records: [
          {
            body: JSON.stringify({
              detail: {
                blobBucket: "platform-artifacts",
                blobByteSize: 12,
                blobContentType: "text/plain",
                blobKey: "memory/legacy.txt",
                blobSha256: "a".repeat(64),
              },
            }),
            messageId: "cleanup-1",
          },
        ],
      },
      {
        deleteBlob: async (reference) => {
          deleted.push(reference);
        },
      },
    );

    expect(result).toEqual({ batchItemFailures: [] });
    expect(deleted).toEqual([
      {
        bucket: "platform-artifacts",
        byteSize: 12,
        contentType: "text/plain",
        key: "memory/legacy.txt",
        sha256: "a".repeat(64),
      },
    ]);
  });
});
