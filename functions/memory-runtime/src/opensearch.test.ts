import { afterEach, describe, expect, it } from "bun:test";
import { openSearchTransport } from "./opensearch.ts";

const approved = "https://search-memory.us-east-2.es.amazonaws.com";
const config = {
  automatedSnapshotRetentionHours: 336,
  backupSafetyMarginMinutes: 60,
  embeddingDimensions: 3,
  openSearchEndpoint: approved,
  openSearchIndex: "memory-v1",
  region: "us-east-2",
};

afterEach(() => delete process.env.DEPLOYMENTS_AI_MEMORY_OPENSEARCH_ENDPOINT);

describe("OpenSearch memory transport", () => {
  it("pins requests to the OpenTofu-managed domain", () => {
    process.env.DEPLOYMENTS_AI_MEMORY_OPENSEARCH_ENDPOINT = approved;
    expect(() => openSearchTransport(config)).not.toThrow();
    expect(() =>
      openSearchTransport({ ...config, openSearchEndpoint: "https://attacker.example" }),
    ).toThrow("approved memory domain");
  });

  it("fails closed when the approved endpoint is unavailable", () => {
    expect(() => openSearchTransport(config)).toThrow("not configured");
  });
});
