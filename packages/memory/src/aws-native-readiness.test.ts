import { describe, expect, it } from "bun:test";
import { makeAwsNativeMemoryProvider, type AwsNativeMemoryConfig } from "./aws-native.ts";
import { ids } from "./test-fixtures.ts";

const config: AwsNativeMemoryConfig = {
  automatedSnapshotRetentionHours: 14 * 24,
  backupSafetyMarginMinutes: 60,
  embeddingDimensions: 3,
  openSearchEndpoint: "https://search-memory.us-east-2.es.amazonaws.com",
  openSearchIndex: "memory-v3",
  region: "us-east-2",
};

function provider(status: number) {
  return makeAwsNativeMemoryProvider({
    config,
    openSearch: { request: async () => Promise.reject({ status }) },
    target: {
      componentIds: [ids.memory2],
      embeddingProfileId: ids.run,
      location: {},
      providerId: "aws-native",
      schemaGeneration: 3,
      targetId: ids.toolCall,
    },
  });
}

describe("AWS-native readiness downgrade", () => {
  it("reports the OpenSearch-only generation unavailable when its index is absent", async () => {
    expect(provider(404).readiness!({ organizationId: ids.organization })).resolves.toEqual({
      denseReady: false,
      lexicalReady: false,
      ready: false,
      reference: "memory-v3",
      schemaReady: false,
    });
  });

  it("continues to propagate genuine OpenSearch transport failures", async () => {
    expect(provider(503).readiness!({ organizationId: ids.organization })).rejects.toMatchObject({
      cause: { status: 503 },
      name: "AwsNativeMemoryError",
      operation: "read-open-search-readiness",
    });
  });
});
