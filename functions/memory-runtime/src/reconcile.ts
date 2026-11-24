import { Schema } from "effect";
import { Ulid } from "@deployments-ai/db";
import type { MemoryPlatform, MemoryPlatformScope } from "@deployments-ai/memory";
import { processQueue, queuePayload, queueScope, type QueueEventLike } from "./queue.ts";
import { runtimeMemoryPlatform } from "./runtime.ts";
// The schedule fires every five minutes per scope, so this caps provider re-verification of
// unchanged memories at 600 index jobs an hour per scope however large the scope grows.
const SCHEDULED_VERIFICATION_LIMIT = 50;

export interface ReconcileEvent {
  readonly cursor?: string;
  readonly environmentId?: string;
  readonly organizationId?: string;
  readonly projectId?: string;
  readonly workspaceId?: string;
}

function scopeFromEvent(event: ReconcileEvent): MemoryPlatformScope {
  if (!event.organizationId || !event.projectId || !event.environmentId) {
    throw new TypeError("Scheduled memory reconciliation requires tenant scope.");
  }
  const decodeId = (value: string, label: string) => {
    try {
      return Schema.decodeUnknownSync(Ulid)(value);
    } catch {
      throw new TypeError(`Scheduled memory reconciliation ${label} must be a valid ULID.`);
    }
  };
  return {
    environmentId: decodeId(event.environmentId, "environmentId"),
    organizationId: decodeId(event.organizationId, "organizationId"),
    projectId: decodeId(event.projectId, "projectId"),
    ...(event.workspaceId ? { workspaceId: decodeId(event.workspaceId, "workspaceId") } : {}),
  };
}

export async function handleMemoryReconcile(
  event: ReconcileEvent | QueueEventLike,
  dependencies: { readonly platform?: MemoryPlatform } = {},
) {
  const platform = dependencies.platform ?? (await runtimeMemoryPlatform());
  if ("Records" in event) {
    return processQueue(event, async (record) => {
      const payload = queuePayload(record);
      await platform.reconcile(
        queueScope(payload),
        typeof payload.cursor === "string" ? { cursor: payload.cursor } : {},
      );
    });
  }
  const scope = scopeFromEvent(event);
  const reconciled = await platform.reconcile(scope, event.cursor ? { cursor: event.cursor } : {});
  const verified = await platform.verifyIndexStates(scope, {
    limit: SCHEDULED_VERIFICATION_LIMIT,
  });
  return { ...reconciled, verified: verified.queued };
}

export const handler = handleMemoryReconcile;
