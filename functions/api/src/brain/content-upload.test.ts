import { describe, expect, test } from "bun:test";
import { HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { makeS3BrainContentUploader } from "./content-upload.ts";

const hash = `sha256:${"00".repeat(32)}`;

function input() {
  return {
    body: new Request("https://upload.example", {
      body: "hello",
      method: "PUT",
    }).body!,
    brainId: "brain",
    bucket: "content-bucket",
    contentLength: 5,
    contentType: "text/plain",
    expectedContentHash: hash,
    kmsKeyArn: "arn:aws:kms:us-east-1:123456789012:key/content",
    objectKey: "organizations/org/brains/brain/uploads/ticket",
    organizationId: "org",
    sourceId: "source",
    ticketId: "ticket",
  };
}

describe("S3 Brain content uploader", () => {
  test("uses a create-only, checksum-verified, versioned KMS write", async () => {
    const commands: unknown[] = [];
    const client = {
      send: async (command: unknown) => {
        commands.push(command);
        return { ETag: '"etag"', VersionId: "version-1" };
      },
    } as S3Client;

    const result = await makeS3BrainContentUploader(client).upload(input());

    expect(commands[0]).toBeInstanceOf(PutObjectCommand);
    expect((commands[0] as PutObjectCommand).input).toMatchObject({
      Bucket: "content-bucket",
      ChecksumSHA256: Buffer.alloc(32).toString("base64"),
      ContentLength: 5,
      ContentType: "text/plain",
      IfNoneMatch: "*",
      Key: "organizations/org/brains/brain/uploads/ticket",
      ServerSideEncryption: "aws:kms",
    });
    expect(result).toMatchObject({ versionId: "version-1", sha256: hash });
  });

  test("reconciles an ambiguous write only when immutable object metadata matches", async () => {
    const commands: unknown[] = [];
    const client = {
      send: async (command: unknown) => {
        commands.push(command);
        if (command instanceof PutObjectCommand) throw new Error("timeout");
        return {
          ChecksumSHA256: Buffer.alloc(32).toString("base64"),
          ContentLength: 5,
          ContentType: "text/plain",
          ETag: '"etag"',
          Metadata: {
            brainid: "brain",
            organizationid: "org",
            sourceid: "source",
            ticketid: "ticket",
          },
          ServerSideEncryption: "aws:kms",
          SSEKMSKeyId: "arn:aws:kms:us-east-1:123456789012:key/content",
          VersionId: "reconciled-version",
        };
      },
    } as S3Client;

    const result = await makeS3BrainContentUploader(client).upload(input());

    expect(commands[1]).toBeInstanceOf(HeadObjectCommand);
    expect(result.versionId).toBe("reconciled-version");
  });

  test("presigns a PUT whose signature covers exactly the headers it hands the client", async () => {
    const client = new S3Client({
      credentials: { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret" },
      region: "us-east-1",
    });
    const { body: _body, ...object } = input();

    const upload = await makeS3BrainContentUploader(client).presign(object, {
      expiresInSeconds: 240,
      signedAt: new Date("2026-07-30T12:01:00.000Z"),
    });
    const url = new URL(upload.url);

    expect(url.searchParams.get("X-Amz-SignedHeaders")?.split(";")).toEqual([
      "content-length",
      "content-type",
      "host",
      "if-none-match",
      "x-amz-checksum-sha256",
      "x-amz-server-side-encryption",
      "x-amz-server-side-encryption-aws-kms-key-id",
      "x-amz-server-side-encryption-context",
    ]);
    expect(Object.keys(upload.headers).toSorted()).toEqual([
      "content-length",
      "content-type",
      "if-none-match",
      "x-amz-checksum-sha256",
      "x-amz-server-side-encryption",
      "x-amz-server-side-encryption-aws-kms-key-id",
      "x-amz-server-side-encryption-context",
    ]);
    expect([
      url.searchParams.get("X-Amz-Expires"),
      url.searchParams.get("x-amz-meta-ticketid"),
      upload.headers["content-length"],
    ]).toEqual(["240", "ticket", "5"]);
  });
});
