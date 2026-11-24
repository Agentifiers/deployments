import { describe, expect, it } from "bun:test";
import type { AwsNativeMemoryConfig, OpenSearchTransport } from "./aws-native-contracts.ts";
import { deleteAwsNativeEvidence } from "./aws-native-evidence.ts";
import { memoryFixture } from "./test-fixtures.ts";

describe("AWS-native synthetic evidence cleanup", () => {
  it("physically deletes evidence from the target-exclusive OpenSearch index", async () => {
    const requests: unknown[] = [];
    const config = { openSearchIndex: "memory-v3" } as AwsNativeMemoryConfig;
    const openSearch = {
      request: async (input: unknown) => {
        requests.push(input);
        return { result: "deleted" };
      },
    } as OpenSearchTransport;

    expect(
      deleteAwsNativeEvidence({ config, memory: memoryFixture(), openSearch }),
    ).resolves.toEqual({ status: "synchronized" });
    expect(requests).toEqual([
      expect.objectContaining({
        method: "DELETE",
        path: expect.stringContaining(`/${config.openSearchIndex}/_doc/`),
      }),
    ]);
  });

  it("preserves the OpenSearch transport cause on deletion failure", async () => {
    const denied = Object.assign(new Error("denied"), { status: 403 });
    const config = { openSearchIndex: "memory-v3" } as AwsNativeMemoryConfig;
    const openSearch = {
      request: async () => {
        throw denied;
      },
    } as OpenSearchTransport;

    expect(
      deleteAwsNativeEvidence({ config, memory: memoryFixture(), openSearch }),
    ).rejects.toMatchObject({
      cause: denied,
      name: "AwsNativeMemoryError",
      operation: "delete-evidence-open-search",
    });
  });
});
