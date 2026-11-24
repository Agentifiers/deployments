import { BlobReference, Ulid } from "@deployments-ai/db";
import type { MemoryBlobDeleter, MemoryPlatform } from "@deployments-ai/memory";
import { Schema } from "effect";
import { processQueue, queuePayload, queueScope, type QueueEventLike } from "./queue.ts";
import { deleteRuntimeMemoryBlob, runtimeMemoryPlatform } from "./runtime.ts";
export async function handleMemoryCleanupQueue(
  event: QueueEventLike,
  dependencies: {
    readonly deleteBlob?: MemoryBlobDeleter;
    readonly platform?: MemoryPlatform;
  } = {},
) {
  return processQueue(event, async (record) => {
    const payload = queuePayload(record);
    if (payload.operation === "review-content-cleanup") {
      const platform = dependencies.platform ?? (await runtimeMemoryPlatform());
      await platform.scrubMemoryReviewContent(
        queueScope(payload),
        Schema.decodeUnknownSync(Ulid)(payload.memoryId),
      );
      return;
    }
    const deleteBlob = dependencies.platform
      ? (reference: Parameters<MemoryBlobDeleter>[0]) =>
          dependencies.platform!.cleanupMemoryBlob(reference)
      : (dependencies.deleteBlob ?? deleteRuntimeMemoryBlob);
    await deleteBlob(
      Schema.decodeUnknownSync(BlobReference)({
        bucket: payload.blobBucket,
        byteSize: payload.blobByteSize,
        contentType: payload.blobContentType,
        key: payload.blobKey,
        sha256: payload.blobSha256,
        ...(typeof payload.blobVersionId === "string" ? { versionId: payload.blobVersionId } : {}),
      }),
    );
  });
}

export const handler = handleMemoryCleanupQueue;
