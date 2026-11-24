import { describe, expect, it } from "bun:test";
import { withCanonicalRecordKeys, type DynamoDatabaseService } from "@deployments-ai/db";
import { makeMemorySearchPlacementResolver } from "./placement.ts";
import type { MemorySearchTarget } from "./provider.ts";
import { ids } from "./test-fixtures.ts";

function target(targetId: string, schemaGeneration: number): MemorySearchTarget {
  return {
    componentIds: [targetId as never],
    embeddingProfileId: targetId as never,
    location: { region: "aws-us-east-2" },
    providerId: "aws-native",
    schemaGeneration,
    targetId: targetId as never,
  };
}

describe("Memory search target placement", () => {
  it("strongly reads the provider-routing boundary", async () => {
    const consistency: (boolean | undefined)[] = [];
    const database = {
      getRecord: async (_table: string, _key: unknown, consistentRead?: boolean) => {
        consistency.push(consistentRead);
        return undefined;
      },
    } as unknown as DynamoDatabaseService;
    const resolve = makeMemorySearchPlacementResolver(database, {
      resolve: async () => {
        throw new Error("provider resolution must not run without a placement");
      },
    });

    expect(resolve(ids.organization)).rejects.toThrow("not configured");
    expect(consistency).toEqual([true]);
  });

  it("fails closed when the serving read target is absent from writes", async () => {
    const readTarget = target("01ARZ3NDEKTSV4RRFFQ69G5FAV", 1);
    const writeTarget = target("01ARZ3NDEKTSV4RRFFQ69G5FAW", 1);
    const placement = withCanonicalRecordKeys({
      data: {
        createdAt: "2026-07-28T12:00:00.000Z",
        generation: 1,
        organizationId: ids.organization,
        phase: "active" as const,
        readTarget,
        updatedAt: "2026-07-28T12:00:00.000Z",
        version: 1,
        writeTargets: [writeTarget],
      },
      itemType: "memory-search-placement" as const,
    });
    const database = {
      getRecord: async () => placement as never,
    } as unknown as DynamoDatabaseService;
    const resolve = makeMemorySearchPlacementResolver(database, {
      resolve: async () => {
        throw new Error("provider resolution must not run for invalid routing");
      },
    });

    expect(resolve(ids.organization)).rejects.toThrow("invalid write targets");
  });
});
