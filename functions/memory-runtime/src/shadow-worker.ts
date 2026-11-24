import { Schema } from "effect";
import { Ulid } from "@deployments-ai/db";
import { type MemoryPlatform } from "@deployments-ai/memory";
import { processQueue, queuePayload, queueScope, type QueueEventLike } from "./queue.ts";
import { runtimeMemoryPlatform } from "./runtime.ts";

export async function handleMemoryShadowQueue(
  event: QueueEventLike,
  dependencies: { readonly platform?: MemoryPlatform } = {},
) {
  const platform = dependencies.platform ?? (await runtimeMemoryPlatform());
  return processQueue(event, async (record) => {
    const payload = queuePayload(record);
    const jobId = Schema.decodeUnknownSync(Ulid)(payload.jobId);
    await platform.executeShadowJob(queueScope(payload), jobId);
  });
}

export const handler = handleMemoryShadowQueue;
