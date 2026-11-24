import { describe, expect, test } from "bun:test";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import {
  ArtifactRecord,
  withCanonicalRecordKeys,
  type DynamoDatabaseService,
  type Ulid,
} from "@deployments-ai/db";
import { Schema } from "effect";
import { createHash } from "node:crypto";
import { createS3RunInputArtifactLoader } from "./input-artifacts.ts";

const id = (suffix: string) => `01ARZ3NDEKTSV4RRFFQ69G${suffix.padStart(4, "0")}` as Ulid;
const scope = {
  organizationId: id("1"),
  projectId: id("2"),
  environmentId: id("3"),
  threadId: id("4"),
};
const owner = { serviceAccountId: id("5"), type: "service-account" as const };
const now = new Date("2026-09-10T12:00:00.000Z");
const bytes = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const digest = createHash("sha256").update(bytes).digest("hex");
const objectKey = [
  "artifacts",
  "organizations",
  scope.organizationId,
  "projects",
  scope.projectId,
  "environments",
  scope.environmentId,
  "customer",
  id("6"),
  digest,
  "frame.jpg",
].join("/");
const request = {
  ...scope,
  agentDefinitionId: id("7"),
  agentDeploymentId: id("8"),
  agentManifestHash: "hash",
  agentReleaseId: id("9"),
  runId: id("10"),
  media: { artifactIds: [id("6")], owner, promptMessageId: id("11") },
};
function setup(
  options: {
    readonly responseBytes?: Uint8Array;
    readonly version?: string;
    readonly threadId?: Ulid;
    readonly retentionExpiresAt?: string;
  } = {},
) {
  const retentionExpiresAt =
    options.retentionExpiresAt ?? new Date(now.getTime() + 1000).toISOString();
  const artifact = Schema.decodeUnknownSync(ArtifactRecord)(
    withCanonicalRecordKeys({
      itemType: "artifact",
      ttl: Math.floor(Date.parse(retentionExpiresAt) / 1000),
      data: {
        ...scope,
        owner,
        id: id("6"),
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        version: 0,
        status: "available",
        visibility: "private",
        name: "frame",
        type: "input",
        input: { kind: "image", mediaType: "image/jpeg" },
        threadId: options.threadId ?? scope.threadId,
        retentionExpiresAt,
        storage: {
          bucket: "private-artifacts",
          key: objectKey,
          byteSize: bytes.byteLength,
          sha256: digest,
          contentType: "image/jpeg",
          fileName: "frame.jpg",
          versionId: "v1",
        },
      },
    }),
  );
  const database: DynamoDatabaseService = {
    getRecord: () => Promise.resolve(artifact),
    queryRecords: () => Promise.resolve({ items: [] }),
    putRecord: async () => {},
    deleteRecord: async () => {},
    transactWrite: async () => {},
  };
  const requests: GetObjectCommand[] = [];
  const load = createS3RunInputArtifactLoader({
    bucket: "private-artifacts",
    database,
    now: () => now,
    client: {
      send: async (command: unknown) => {
        if (!(command instanceof GetObjectCommand)) throw new Error("Unexpected S3 operation");
        requests.push(command);
        return {
          ContentLength: bytes.byteLength,
          ContentType: "image/jpeg",
          VersionId: options.version ?? "v1",
          Body: (async function* () {
            yield options.responseBytes ?? bytes;
          })(),
        };
      },
    } as never,
  });
  return { load, requests };
}

describe("private model input byte loading", () => {
  test("loads only the committed version and preserves private binary content", async () => {
    const fixture = setup();
    const result = await fixture.load(request);
    expect(result[0]).toMatchObject({
      content: bytes,
      messageId: request.media.promptMessageId,
      threadId: request.threadId,
      contentType: "image/jpeg",
    });
    expect(fixture.requests[0]?.input).toMatchObject({ Key: objectKey, VersionId: "v1" });
  });

  test("rejects changed bytes, changed versions and an oversized stream", async () => {
    expect(
      setup({ responseBytes: Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 4, 5, 6]) }).load(request),
    ).rejects.toThrow();
    expect(setup({ version: "v2" }).load(request)).rejects.toThrow();
    expect(
      setup({ responseBytes: new Uint8Array(bytes.byteLength + 1) }).load(request),
    ).rejects.toThrow();
  });

  test("does not fetch another thread's artifact or one expiring exactly now", async () => {
    for (const fixture of [
      setup({ threadId: id("12") }),
      setup({ retentionExpiresAt: now.toISOString() }),
    ]) {
      expect(fixture.load(request)).rejects.toMatchObject({
        code: "input_artifact_unavailable",
      });
      expect(fixture.requests).toEqual([]);
    }
  });
});
