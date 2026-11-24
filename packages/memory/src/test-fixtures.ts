import { withCanonicalRecordKeys, type Ulid } from "@deployments-ai/db";
import type { CanonicalMemoryRecord } from "./memory-record.ts";
import { memoryContentHash } from "./governance.ts";
const memoryBody = "Use the production change window on Tuesdays.";

export const ids = {
  agent: "01ARZ3NDEKTSV4RRFFQ69G5FA1" as Ulid,
  environment: "01ARZ3NDEKTSV4RRFFQ69G5FA2" as Ulid,
  memory: "01ARZ3NDEKTSV4RRFFQ69G5FA3" as Ulid,
  memory2: "01ARZ3NDEKTSV4RRFFQ69G5FA4" as Ulid,
  organization: "01ARZ3NDEKTSV4RRFFQ69G5FA5" as Ulid,
  project: "01ARZ3NDEKTSV4RRFFQ69G5FA6" as Ulid,
  space: "01ARZ3NDEKTSV4RRFFQ69G5FA7" as Ulid,
  workspace: "01ARZ3NDEKTSV4RRFFQ69G5FA8" as Ulid,
  run: "01ARZ3NDEKTSV4RRFFQ69G5FA9" as Ulid,
  thread: "01ARZ3NDEKTSV4RRFFQ69G5FAA" as Ulid,
  toolCall: "01ARZ3NDEKTSV4RRFFQ69G5FAB" as Ulid,
} as const;

export const memoryEmbeddingGatewayRoute = JSON.stringify({
  bifrostModelId: "openai/text-embedding-3-small",
  fallbackModelIds: [],
  modelId: "openai/text-embedding-3-small",
  provider: "openai",
  providerModelId: "text-embedding-3-small",
  requestedModelId: "openai/text-embedding-3-small",
  routeScopeRef: `organization:${ids.organization}`,
});

export function memoryFixture(
  overrides: Partial<CanonicalMemoryRecord["data"]> = {},
): CanonicalMemoryRecord {
  return withCanonicalRecordKeys({
    data: {
      body: memoryBody,
      contentHash: memoryContentHash(memoryBody),
      createdAt: "2026-07-21T12:00:00.000Z",
      environmentId: ids.environment,
      id: ids.memory,
      memorySpaceId: ids.space,
      organizationId: ids.organization,
      projectId: ids.project,
      reviewStatus: "approved" as const,
      scope: "workspace" as const,
      searchKey: `workspace:${ids.workspace}`,
      sensitivity: "internal" as const,
      source: "tool",
      status: "active" as const,
      updatedAt: "2026-07-21T12:00:00.000Z",
      version: 3,
      workspaceId: ids.workspace,
      ...overrides,
    },
    itemType: "memory" as const,
  }) as CanonicalMemoryRecord;
}

/** Reads an optional string ExpressionAttributeValue in fake DynamoDB queries; throws on any other type. */
export function optionalExpressionString(
  expressions: Readonly<Record<string, unknown>> | undefined,
  key: string,
): string | undefined {
  const value = expressions?.[key];
  if (value === undefined || typeof value === "string") return value;
  throw new TypeError(
    `Expected ExpressionAttributeValues["${key}"] to be a string, got ${typeof value}`,
  );
}
