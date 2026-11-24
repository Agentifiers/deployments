import { describe, expect, test } from "bun:test";
import { HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";
import { makeS3BrainTextRenditionStore } from "./text-rendition-store.ts";

const kmsKeyArn = "arn:aws:kms:us-east-2:123456789012:key/data";
const key = "organizations/org/brains/brain/document-versions/version/text/document-text-v1.txt";
const text = new TextEncoder().encode("--- Page 1 ---\nRevenue summary");
const digest = createHash("sha256").update(text).digest();
const sha256 = `sha256:${digest.toString("hex")}`;
const preconditionFailed = Object.assign(new Error("At least one precondition failed."), {
  name: "PreconditionFailed",
});

function client(respond: (command: unknown) => unknown) {
  const commands: unknown[] = [];
  return {
    commands,
    s3: {
      send: async (command: unknown) => {
        commands.push(command);
        return respond(command);
      },
    } as S3Client,
  };
}

describe("S3 Brain text rendition store", () => {
  test("writes extracted text once, checksummed and encrypted with the data key", async () => {
    const fake = client(() => ({ VersionId: "text-version-1" }));

    const stored = await makeS3BrainTextRenditionStore({
      bucket: "content",
      kmsKeyArn,
      s3: fake.s3,
    }).putOnce({ key, sha256, text });

    const [put] = fake.commands;
    expect(fake.commands).toHaveLength(1);
    expect(put instanceof PutObjectCommand && put.input).toEqual({
      Body: text,
      Bucket: "content",
      ChecksumSHA256: digest.toString("base64"),
      ContentLength: text.byteLength,
      ContentType: "text/plain; charset=utf-8",
      IfNoneMatch: "*",
      Key: key,
      ServerSideEncryption: "aws:kms",
      SSEKMSKeyId: kmsKeyArn,
    });
    expect(stored).toEqual({
      bucket: "content",
      byteSize: text.byteLength,
      contentType: "text/plain; charset=utf-8",
      key,
      sha256,
      versionId: "text-version-1",
    });
  });

  test("adopts the same text an earlier attempt already stored", async () => {
    const fake = client((command) => {
      if (command instanceof PutObjectCommand) throw preconditionFailed;
      return {
        ChecksumSHA256: digest.toString("base64"),
        ContentLength: text.byteLength,
        VersionId: "text-version-0",
      };
    });

    const stored = await makeS3BrainTextRenditionStore({
      bucket: "content",
      kmsKeyArn,
      s3: fake.s3,
    }).putOnce({ key, sha256, text });

    const head = fake.commands[1];
    expect(head instanceof HeadObjectCommand && head.input).toEqual({
      Bucket: "content",
      ChecksumMode: "ENABLED",
      Key: key,
    });
    expect(stored.versionId).toBe("text-version-0");
  });

  test("refuses to adopt different text stored at the same key", async () => {
    const fake = client((command) => {
      if (command instanceof PutObjectCommand) throw preconditionFailed;
      return {
        ChecksumSHA256: Buffer.alloc(32).toString("base64"),
        ContentLength: text.byteLength,
        VersionId: "text-version-0",
      };
    });

    expect(
      makeS3BrainTextRenditionStore({ bucket: "content", kmsKeyArn, s3: fake.s3 }).putOnce({
        key,
        sha256,
        text,
      }),
    ).rejects.toBe(preconditionFailed);
  });

  test("presigns a GET of exactly the original's object version", async () => {
    const store = makeS3BrainTextRenditionStore({
      bucket: "content",
      kmsKeyArn,
      s3: new S3Client({
        credentials: { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret" },
        region: "us-east-2",
      }),
    });

    const url = new URL(
      await store.presign({
        bucket: "content",
        byteSize: 10,
        contentType: "application/pdf",
        key: "organizations/org/brains/brain/uploads/version",
        sha256: "sha256:pdf",
        versionId: "pdf-version",
      }),
    );

    expect(`${url.origin}${url.pathname}`).toBe(
      "https://content.s3.us-east-2.amazonaws.com/organizations/org/brains/brain/uploads/version",
    );
    expect(url.searchParams.get("versionId")).toBe("pdf-version");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("300");
  });
});
