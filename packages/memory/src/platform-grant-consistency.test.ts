import { describe, expect, it } from "bun:test";
import {
  type DynamoDatabaseService,
  type PlatformRecord,
  withCanonicalRecordKeys,
} from "@deployments-ai/db";
import { makeMemoryPlatformGrantList } from "./platform-grant-list.ts";
import type { MemoryPlatformRuntime } from "./platform-shared.ts";
import type { MemorySpaceGrant } from "./platform-types.ts";
import { ids } from "./test-fixtures.ts";

function grant(permission: "read" | "read-write", revokedAt?: string) {
  return withCanonicalRecordKeys({
    data: {
      agentDefinitionId: ids.agent,
      createdAt: "2026-07-23T00:00:00.000Z",
      environmentId: ids.environment,
      id: ids.memory2,
      memorySpaceId: ids.space,
      organizationId: ids.organization,
      permission,
      projectId: ids.project,
      ...(revokedAt ? { revokedAt } : {}),
      updatedAt: "2026-07-23T00:00:00.000Z",
      version: revokedAt || permission === "read" ? 1 : 0,
    },
    itemType: "memory-space-grant" as const,
  }) as MemorySpaceGrant;
}

describe("memory grant consistency", () => {
  it("strongly revalidates stale grant index projections", async () => {
    const stale = grant("read-write");
    let canonical: MemorySpaceGrant = grant("read");
    const database = {
      getRecord: async () => canonical as PlatformRecord,
      queryRecords: async () => ({ items: [stale] }),
    } as unknown as DynamoDatabaseService;
    const platform = makeMemoryPlatformGrantList({ database } as MemoryPlatformRuntime);
    const scope = {
      environmentId: ids.environment,
      organizationId: ids.organization,
      projectId: ids.project,
    };

    expect(
      platform.listMemorySpaceGrants(scope, { agentDefinitionId: ids.agent }),
    ).resolves.toMatchObject([{ data: { permission: "read" } }]);

    canonical = grant("read", "2026-07-23T00:01:00.000Z");
    expect(
      platform.listMemorySpaceGrants(scope, { agentDefinitionId: ids.agent }),
    ).resolves.toEqual([]);
  });

  it("finds a new grant through a strongly consistent base-table fallback", async () => {
    const canonical = grant("read-write");
    const queryInputs: Record<string, unknown>[] = [];
    const database = {
      getRecord: async () => undefined,
      queryRecords: async (_table: string, input: Record<string, unknown>) => {
        queryInputs.push(input);
        return { items: input.IndexName === "gsi1" ? [] : [canonical] };
      },
    } as unknown as DynamoDatabaseService;
    const platform = makeMemoryPlatformGrantList({ database } as MemoryPlatformRuntime);
    const scope = {
      environmentId: ids.environment,
      organizationId: ids.organization,
      projectId: ids.project,
    };

    expect(
      platform.listMemorySpaceGrants(scope, {
        agentDefinitionId: ids.agent,
        consistent: true,
      }),
    ).resolves.toMatchObject([{ data: { permission: "read-write" } }]);
    expect(queryInputs).toHaveLength(1);
    expect(queryInputs[0]).toMatchObject({ ConsistentRead: true });
    expect(queryInputs[0]).not.toHaveProperty("IndexName");
  });
});
