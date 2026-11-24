import {
  ModelUsageLedgerEntrySchema,
  type ModelUsageLedgerEntry,
} from "@deployments-ai/model-gateway";
import { ObservabilitySourceContext, Ulid } from "@deployments-ai/db";
import { Schema } from "effect";
import { processQueue, queuePayload, type QueueEventLike } from "./queue.ts";
import { recordRuntimeModelUsage } from "./runtime.ts";

function requiredString(value: unknown, label: string) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${label} is required.`);
  return value.trim();
}

export async function handleMemoryUsageQueue(
  event: QueueEventLike,
  dependencies: { readonly recordUsage?: typeof recordRuntimeModelUsage } = {},
) {
  return processQueue(event, async (record) => {
    const payload = queuePayload(record);
    const scopeValue = payload.scope;
    if (!scopeValue || typeof scopeValue !== "object" || Array.isArray(scopeValue)) {
      throw new TypeError("Memory usage retry scope is required.");
    }
    const scope = scopeValue as Record<string, unknown>;
    const entryValue = payload.entry;
    const entry = Schema.decodeUnknownSync(ModelUsageLedgerEntrySchema)(
      // Retries enqueued before usage recorded its payer were all operator-funded.
      entryValue && typeof entryValue === "object" && !("payer" in entryValue)
        ? { ...entryValue, payer: { kind: "operator" } }
        : entryValue,
    ) as ModelUsageLedgerEntry;
    const tenant = {
      environmentId: Schema.decodeUnknownSync(Ulid)(
        requiredString(scope.environmentId, "scope.environmentId"),
      ),
      organizationId: Schema.decodeUnknownSync(Ulid)(
        requiredString(scope.organizationId, "scope.organizationId"),
      ),
      projectId: Schema.decodeUnknownSync(Ulid)(requiredString(scope.projectId, "scope.projectId")),
      workspaceId: Schema.decodeUnknownSync(Schema.UndefinedOr(Ulid))(scope.workspaceId),
    };
    if (typeof scope.runId === "string") {
      await (dependencies.recordUsage ?? recordRuntimeModelUsage)(entry, {
        ...tenant,
        observability: Schema.decodeUnknownSync(ObservabilitySourceContext)(scope.observability),
        runId: Schema.decodeUnknownSync(Ulid)(scope.runId),
      });
      return;
    }
    await (dependencies.recordUsage ?? recordRuntimeModelUsage)(entry, {
      ...tenant,
      operationId: Schema.decodeUnknownSync(Ulid)(
        requiredString(scope.operationId, "scope.operationId"),
      ),
      operationType: requiredString(scope.operationType, "scope.operationType"),
    });
  });
}

export const handler = handleMemoryUsageQueue;
