import { describe, expect, test } from "bun:test";
import {
  DeleteObjectCommand,
  HeadObjectCommand,
  S3Client,
  type HeadObjectCommandOutput,
} from "@aws-sdk/client-s3";
import { MAX_SANDBOX_WORKSPACE_SNAPSHOT_BYTES } from "@deployments-ai/db";
import {
  ThreadSandboxSnapshotIntegrityError,
  createS3ThreadSandboxSnapshotStore,
  threadSandboxSnapshotKey,
} from "./snapshot-store.ts";

const KMS_KEY = "arn:aws:kms:us-east-2:123456789012:key/11111111-2222-3333-4444-555555555555";
const sha256 = "ab".repeat(32);
const checksum = Buffer.from(sha256, "hex").toString("base64");
const object = { byteSize: 4096, key: "organizations/org/sandbox-workspaces/s.tar.gz", sha256 };

function store(respond: (command: unknown) => unknown = () => ({})) {
  const client = new S3Client({
    credentials: { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret" },
    region: "us-east-2",
  });
  const sent: unknown[] = [];
  client.send = (async (command: unknown) => {
    sent.push(command);
    return respond(command);
  }) as typeof client.send;
  return {
    sent,
    store: createS3ThreadSandboxSnapshotStore({ bucket: "artifacts", client, kmsKeyId: KMS_KEY }),
  };
}

const head = (overrides: Partial<HeadObjectCommandOutput> = {}) => ({
  ChecksumSHA256: checksum,
  ContentLength: object.byteSize,
  SSEKMSKeyId: KMS_KEY,
  ServerSideEncryption: "aws:kms",
  VersionId: "v7",
  ...overrides,
});

describe("S3 thread sandbox snapshot store", () => {
  test("builds tenant-prefixed snapshot keys", () => {
    expect(
      threadSandboxSnapshotKey(
        {
          environmentId: "env",
          executionTargetId: "dep",
          executionTargetKind: "agent-deployment",
          organizationId: "org",
          projectId: "proj",
          threadId: "thr",
        },
        "snap",
      ),
    ).toBe(
      "organizations/org/sandbox-workspaces/projects/proj/environments/env/threads/thr/execution-targets/agent-deployment/dep/snap.tar.gz",
    );
  });

  test("presigns a create-only KMS upload whose checksum and encryption are signed headers", async () => {
    const upload = await store().store.presignUpload(object);
    const url = new URL(upload.url);

    expect(upload.headers).toEqual({
      "content-type": "application/gzip",
      "if-none-match": "*",
      "x-amz-checksum-sha256": checksum,
      "x-amz-server-side-encryption": "aws:kms",
      "x-amz-server-side-encryption-aws-kms-key-id": KMS_KEY,
    });
    expect(url.protocol).toBe("https:");
    expect(url.pathname).toBe(`/${object.key}`);
    expect(url.searchParams.get("X-Amz-SignedHeaders")?.split(";").sort()).toEqual(
      [...Object.keys(upload.headers), "host"].sort(),
    );
    expect(url.searchParams.get("X-Amz-Expires")).toBe("900");
    for (const name of url.searchParams.keys()) {
      expect(name.toLowerCase()).not.toContain("server-side-encryption");
      expect(name.toLowerCase()).not.toContain("checksum");
    }
  });

  test.each([
    ["an empty archive", { ...object, byteSize: 0 }],
    [
      "an archive over the single-PUT limit",
      { ...object, byteSize: MAX_SANDBOX_WORKSPACE_SNAPSHOT_BYTES + 1 },
    ],
    ["a malformed digest", { ...object, sha256: "AB".repeat(32) }],
  ])("refuses to presign %s", async (_label, invalid) => {
    expect(store().store.presignUpload(invalid)).rejects.toBeInstanceOf(
      ThreadSandboxSnapshotIntegrityError,
    );
  });

  test("presigns a download of the exact archive version", async () => {
    const url = new URL(
      await store().store.presignDownload({ ...object, bucket: "artifacts", versionId: "v7" }),
    );

    expect(url.pathname).toBe(`/${object.key}`);
    expect(url.searchParams.get("versionId")).toBe("v7");
  });

  test("confirms an upload by its stored checksum, size, and KMS key", async () => {
    const s3 = store(() => head());

    expect(s3.store.confirmUpload(object)).resolves.toEqual({
      ...object,
      bucket: "artifacts",
      versionId: "v7",
    });
    const command = s3.sent[0] as HeadObjectCommand;
    expect(command).toBeInstanceOf(HeadObjectCommand);
    expect(command.input).toEqual({
      Bucket: "artifacts",
      ChecksumMode: "ENABLED",
      Key: object.key,
    });
  });

  test.each([
    ["checksum", { ChecksumSHA256: Buffer.from("cd".repeat(32), "hex").toString("base64") }],
    ["size", { ContentLength: object.byteSize - 1 }],
    ["encryption", { ServerSideEncryption: "AES256" as const }],
    ["KMS key", { SSEKMSKeyId: `${KMS_KEY}-other` }],
    ["version", { VersionId: undefined }],
  ])("rejects an upload whose %s does not match", async (_label, overrides) => {
    expect(store(() => head(overrides)).store.confirmUpload(object)).rejects.toBeInstanceOf(
      ThreadSandboxSnapshotIntegrityError,
    );
  });

  test("deletes the exact snapshot version", async () => {
    const s3 = store();

    await s3.store.delete({ ...object, bucket: "artifacts", versionId: "v7" });

    const command = s3.sent[0] as DeleteObjectCommand;
    expect(command.input).toEqual({ Bucket: "artifacts", Key: object.key, VersionId: "v7" });
  });
});
