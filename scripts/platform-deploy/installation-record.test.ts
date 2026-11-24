import { describe, expect, test } from "bun:test";
import { DEFAULT_TABLE_NAMES } from "@deployments-ai/db";
import { fakeDynamoDocumentClient } from "@deployments-ai/db/dynamo-testing";
import { recordInstallation, type InstallationRecordInput } from "./installation-record.ts";
import { rootProfiles } from "./profiles.ts";
import type { VerifiedRelease } from "./release-bundle.ts";

const sha = (character: string) => character.repeat(64);

const release = {
  artifacts: {
    "memory-runtime": { path: "/bundle/memory.zip", sha256: sha("2") },
    "platform-api": { path: "/bundle/api.zip", sha256: sha("1") },
  },
  images: {
    "durable-streams": {
      digest: `sha256:${sha("3")}`,
      file: "images/durable-streams.oci.tar",
      path: "/bundle/images/durable-streams.oci.tar",
      platform: "linux/amd64",
      sha256: sha("4"),
    },
  },
  manifestSha256: sha("5"),
  sourceCommit: "0123456789abcdef0123456789abcdef01234567",
} as unknown as VerifiedRelease;

const input: InstallationRecordInput = {
  deployedBy: "arn:aws:sts::123456789012:assumed-role/deployer/ci",
  images: {
    "durable-streams": `123456789012.dkr.ecr.us-east-2.amazonaws.com/streams@sha256:${sha("6")}`,
  },
  lambdaFunctions: [
    { artifact: "platform-api", codeSha256: sha("7"), functionName: "api" },
    { artifact: "platform-api", codeSha256: sha("8"), functionName: "governance-worker" },
  ],
  outputs: {
    memory_api_endpoint: null,
    platform_api_endpoint: "https://api.example.com",
    stream_gateway_base_url: "https://streams.example.com",
  },
  release,
  target: {
    aws: { accountId: "123456789012", region: "us-east-2" },
    name: "acme-prod",
    profile: rootProfiles["platform-prod"],
    profileName: "platform-prod",
  } as unknown as InstallationRecordInput["target"],
};

describe("installation record step", () => {
  test("records the verified release as an installation deployment", async () => {
    const table = fakeDynamoDocumentClient();

    await recordInstallation({ client: table.client, tableNames: DEFAULT_TABLE_NAMES }, input);

    expect(
      table
        .items("control")
        .filter((item) => item.itemType === "installation-deployment")
        .map((item) => item.data),
    ).toEqual([
      {
        awsAccountId: "123456789012",
        awsRegion: "us-east-2",
        createdAt: expect.any(String),
        deployedAt: expect.any(String),
        deployedBy: "arn:aws:sts::123456789012:assumed-role/deployer/ci",
        endpoints: [
          { name: "platform-api", url: "https://api.example.com" },
          { name: "stream-gateway", url: "https://streams.example.com" },
        ],
        id: expect.any(String),
        images: [
          {
            imageId: `sha256:${sha("3")}`,
            name: "durable-streams",
            uri: `123456789012.dkr.ecr.us-east-2.amazonaws.com/streams@sha256:${sha("6")}`,
          },
        ],
        lambdaArtifacts: [
          { functions: [], name: "memory-runtime", sha256: sha("2") },
          {
            functions: [
              { codeSha256: sha("7"), name: "api" },
              { codeSha256: sha("8"), name: "governance-worker" },
            ],
            name: "platform-api",
            sha256: sha("1"),
          },
        ],
        profile: "platform-prod",
        releaseManifestSha256: sha("5"),
        sourceCommit: "0123456789abcdef0123456789abcdef01234567",
        targetName: "acme-prod",
      },
    ]);
  });
});
