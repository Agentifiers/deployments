import { describe, expect, test } from "bun:test";
import type { MemorySearchProviderClient } from "./provider.ts";
import { makeServingReadinessCache } from "./serving-readiness-cache.ts";
import { ids } from "./test-fixtures.ts";

function provider(targetId: string, calls: AbortSignal[]) {
  return {
    providerId: "aws-native",
    readiness: async (input: { readonly signal?: AbortSignal }) => {
      calls.push(input.signal!);
      return {
        denseReady: true,
        lexicalReady: true,
        ready: true,
        reference: targetId,
        schemaReady: true,
      };
    },
    target: {
      componentIds: [ids.run],
      embeddingProfileId: ids.toolCall,
      location: { region: "us-east-2" },
      providerId: "aws-native",
      schemaGeneration: 2,
      targetId,
    },
  } as unknown as MemorySearchProviderClient;
}

describe("serving readiness cache", () => {
  test("shares a successful readiness request with its own bounded signal", async () => {
    const calls: AbortSignal[] = [];
    const cache = makeServingReadinessCache({ requestTimeoutMs: 1_000 });
    const target = provider(ids.run, calls);

    await cache.read(target, ids.organization);
    await cache.read(target, ids.organization);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toBeInstanceOf(AbortSignal);
    expect(calls[0]?.aborted).toBe(false);
  });

  test("evicts the oldest live entry when the bounded cache is full", async () => {
    const firstCalls: AbortSignal[] = [];
    const secondCalls: AbortSignal[] = [];
    const cache = makeServingReadinessCache({ maxEntries: 1, now: () => 0 });
    const first = provider(ids.run, firstCalls);
    const second = provider(ids.toolCall, secondCalls);

    await cache.read(first, ids.organization);
    await cache.read(second, ids.organization);
    await cache.read(first, ids.organization);

    expect(firstCalls).toHaveLength(2);
    expect(secondCalls).toHaveLength(1);
  });
});
