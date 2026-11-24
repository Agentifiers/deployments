import { makeMemoryMutationLifecycle } from "./memory-mutation-lifecycle.ts";
import { makeMemoryReviewLifecycle } from "./memory-review-lifecycle.ts";
import type { MemoryPlatformCore } from "./platform-core.ts";
import * as Shared from "./platform-shared.ts";

function makeMemoryLifecycleContext(runtime: Shared.MemoryPlatformRuntime & MemoryPlatformCore) {
  const {
    cursorCodec,
    database,
    generateId,
    now,
    idempotencyReplay,
    completedIdempotency,
    idempotencyOperation,
    eventFor,
    blobCleanupEvent,
    reviewContentCleanupEvent,
    requiredMutableMemory,
    requiredMutableSpace,
    preparedIndexJob,
    queuedIndexJob,
  } = runtime;
  return {
    cursorCodec,
    database,
    generateId,
    now,
    idempotencyReplay,
    completedIdempotency,
    idempotencyOperation,
    eventFor,
    blobCleanupEvent,
    reviewContentCleanupEvent,
    requiredMutableMemory,
    requiredMutableSpace,
    preparedIndexJob,
    queuedIndexJob,
  };
}

export type MemoryLifecycleContext = ReturnType<typeof makeMemoryLifecycleContext>;

export function makeMemoryPlatformLifecycle(
  runtime: Shared.MemoryPlatformRuntime & MemoryPlatformCore,
) {
  const context = makeMemoryLifecycleContext(runtime);
  const mutation = makeMemoryMutationLifecycle(context);
  const review = makeMemoryReviewLifecycle({ ...context, ...mutation });
  return { ...mutation, ...review };
}
