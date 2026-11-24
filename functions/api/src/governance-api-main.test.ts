import { describe, expect, test } from "bun:test";
import { governanceConfigurationEnabled } from "./governance-api-main.ts";

describe("platform API governance initialization", () => {
  test("keeps governance optional for the local API runtime", () => {
    expect(governanceConfigurationEnabled({})).toBe(false);
  });

  test("requires governance runtime settings as one complete group", () => {
    expect(() =>
      governanceConfigurationEnabled({
        DEPLOYMENTS_AI_GOVERNANCE_BUCKET: "governance",
      }),
    ).toThrow("must be configured together");

    expect(() =>
      governanceConfigurationEnabled({
        DEPLOYMENTS_AI_ARTIFACT_KMS_KEY_ARN: "arn:aws:kms:us-east-1:123456789012:key/artifacts",
        DEPLOYMENTS_AI_GOVERNANCE_BUCKET: "governance",
        DEPLOYMENTS_AI_GOVERNANCE_QUEUE_URL:
          "https://sqs.us-east-1.amazonaws.com/123456789012/governance",
        DEPLOYMENTS_AI_GOVERNANCE_SIGNING_KEY_ARN:
          "arn:aws:kms:us-east-1:123456789012:key/governance",
      }),
    ).toThrow("DEPLOYMENTS_AI_MEMORY_ERASURE_FUNCTION_NAME");

    expect(
      governanceConfigurationEnabled({
        DEPLOYMENTS_AI_ARTIFACT_KMS_KEY_ARN: "arn:aws:kms:us-east-1:123456789012:key/artifacts",
        DEPLOYMENTS_AI_GOVERNANCE_BUCKET: "governance",
        DEPLOYMENTS_AI_GOVERNANCE_QUEUE_URL:
          "https://sqs.us-east-1.amazonaws.com/123456789012/governance",
        DEPLOYMENTS_AI_GOVERNANCE_SIGNING_KEY_ARN:
          "arn:aws:kms:us-east-1:123456789012:key/governance",
        DEPLOYMENTS_AI_MEMORY_ERASURE_FUNCTION_NAME: "memory-erasure",
      }),
    ).toBe(true);
  });
});
