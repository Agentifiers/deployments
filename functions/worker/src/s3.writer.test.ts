import { HeadObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { describe, expect, it } from "bun:test";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { bodyWrite, KMS_KEY_ARN, messageBodyKey } from "./s3.fixture.ts";
import { createS3MessageBodyWriter } from "./s3.ts";
import { AgentRunMessageBodyWriteOutcomeUnknownError } from "./types.ts";

function matchingHead(body: string, versionId = "existing-version") {
  const bytes = new TextEncoder().encode(body);
  const digest = createHash("sha256").update(bytes).digest("hex");
  return {
    ChecksumSHA256: Buffer.from(digest, "hex").toString("base64"),
    ContentLength: bytes.byteLength,
    ContentType: "text/plain; charset=utf-8",
    ETag: '"existing-etag"',
    Metadata: {
      messageId: bodyWrite(body).messageId,
      runId: bodyWrite(body).run.data.id,
      sha256: digest,
    },
    ServerSideEncryption: "aws:kms",
    SSEKMSKeyId: KMS_KEY_ARN,
    VersionId: versionId,
  } as const;
}

describe("S3 message body writer", () => {
  it("writes a conditional KMS-encrypted object and returns its pinned version", async () => {
    const calls: PutObjectCommand[] = [];
    const write = createS3MessageBodyWriter({
      bucket: "platform-message-bodies",
      kmsKeyId: KMS_KEY_ARN,
      client: {
        send: async (command) => {
          calls.push(command as unknown as PutObjectCommand);
          return { ETag: '"etag"', VersionId: "version-1" };
        },
      } as Pick<S3Client, "send">,
    });
    const input = bodyWrite("assistant output");
    const result = await write(input);
    expect(calls[0]?.input).toMatchObject({
      Bucket: "platform-message-bodies",
      IfNoneMatch: "*",
      ServerSideEncryption: "aws:kms",
      SSEKMSKeyId: KMS_KEY_ARN,
    });
    expect(result.versionId).toBe("version-1");
    expect(result.key).toBe(messageBodyKey(input.contentHash));
  });

  it("rejects invalid limits, KMS keys, and content hashes before dispatch", async () => {
    expect(() => createS3MessageBodyWriter({ bucket: "bucket", kmsKeyId: "alias/key" })).toThrow(
      "canonical key ARN",
    );
    expect(() =>
      createS3MessageBodyWriter({ bucket: "bucket", kmsKeyId: KMS_KEY_ARN, maxBodyBytes: 0 }),
    ).toThrow("positive integer");
    let sends = 0;
    const write = createS3MessageBodyWriter({
      bucket: "bucket",
      kmsKeyId: KMS_KEY_ARN,
      maxBodyBytes: 2,
      client: {
        send: async () => {
          sends += 1;
          return {};
        },
      } as Pick<S3Client, "send">,
    });
    expect(write(bodyWrite("too long"))).rejects.toThrow("write limit");
    expect(write({ ...bodyWrite("ok"), contentHash: "0".repeat(64) })).rejects.toThrow(
      "content hash",
    );
    expect(sends).toBe(0);
  });

  it("reconciles a conditional conflict against a matching existing object", async () => {
    const body = "retry body";
    const commands: unknown[] = [];
    const write = createS3MessageBodyWriter({
      bucket: "bucket",
      kmsKeyId: KMS_KEY_ARN,
      client: {
        send: async (command) => {
          commands.push(command);
          if (command instanceof PutObjectCommand)
            throw { name: "PreconditionFailed", $metadata: { httpStatusCode: 412 } };
          return matchingHead(body);
        },
      } as Pick<S3Client, "send">,
    });
    expect(write(bodyWrite(body))).resolves.toMatchObject({ versionId: "existing-version" });
    expect(commands.some((command) => command instanceof HeadObjectCommand)).toBe(true);
  });

  it("rejects a conflicting existing object whose metadata differs", async () => {
    const body = "retry body";
    const write = createS3MessageBodyWriter({
      bucket: "bucket",
      kmsKeyId: KMS_KEY_ARN,
      client: {
        send: async (command) => {
          if (command instanceof PutObjectCommand) throw { name: "PreconditionFailed" };
          return {
            ...matchingHead(body),
            Metadata: { ...matchingHead(body).Metadata, runId: "other" },
          };
        },
      } as Pick<S3Client, "send">,
    });
    expect(write(bodyWrite(body))).rejects.toThrow("does not match the retry payload");
  });

  it("reconciles an ambiguous provider timeout when the object committed", async () => {
    const body = "ambiguous body";
    const write = createS3MessageBodyWriter({
      bucket: "bucket",
      kmsKeyId: KMS_KEY_ARN,
      client: {
        send: async (command) => {
          if (command instanceof PutObjectCommand) throw { name: "TimeoutError" };
          return matchingHead(body);
        },
      } as Pick<S3Client, "send">,
    });
    expect(write(bodyWrite(body))).resolves.toMatchObject({ versionId: "existing-version" });
  });

  it("keeps ambiguous writes retryable when provider reconciliation fails", async () => {
    const write = createS3MessageBodyWriter({
      bucket: "bucket",
      kmsKeyId: KMS_KEY_ARN,
      client: {
        send: async (command) => {
          if (command instanceof PutObjectCommand) throw { name: "TimeoutError" };
          throw new Error("head unavailable");
        },
      } as Pick<S3Client, "send">,
    });
    expect(write(bodyWrite("ambiguous body"))).rejects.toBeInstanceOf(
      AgentRunMessageBodyWriteOutcomeUnknownError,
    );
  });

  it("retries conditional request conflicts before succeeding", async () => {
    let puts = 0;
    const write = createS3MessageBodyWriter({
      bucket: "bucket",
      kmsKeyId: KMS_KEY_ARN,
      client: {
        send: async (command) => {
          if (command instanceof PutObjectCommand && ++puts < 3)
            throw { name: "ConditionalRequestConflict" };
          return { VersionId: "version-3" };
        },
      } as Pick<S3Client, "send">,
    });
    expect(write(bodyWrite("retry body"))).resolves.toMatchObject({ versionId: "version-3" });
    expect(puts).toBe(3);
  });

  it("reconciles a successful put that omits its version ID", async () => {
    const body = "missing version";
    const write = createS3MessageBodyWriter({
      bucket: "bucket",
      kmsKeyId: KMS_KEY_ARN,
      client: {
        send: async (command) =>
          command instanceof PutObjectCommand ? {} : matchingHead(body, "reconciled-version"),
      } as Pick<S3Client, "send">,
    });
    expect(write(bodyWrite(body))).resolves.toMatchObject({
      versionId: "reconciled-version",
    });
  });

  it("uses a configured object-key prefix", async () => {
    const write = createS3MessageBodyWriter({
      bucket: "bucket",
      keyPrefix: "/custom/",
      kmsKeyId: KMS_KEY_ARN,
      client: { send: async () => ({ VersionId: "version" }) } as Pick<S3Client, "send">,
    });
    const result = await write(bodyWrite("custom prefix"));
    expect(result.key.startsWith("custom/organizations/")).toBe(true);
  });
});
