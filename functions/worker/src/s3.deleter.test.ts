import { DeleteObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { describe, expect, it } from "bun:test";
import { bodyWrite, messageBodyKey } from "./s3.fixture.ts";
import { createS3MessageBodyDeleter } from "./s3.ts";

describe("S3 message body deleter", () => {
  it("deletes the exact object version with the caller abort signal", async () => {
    const calls: Array<{ command: DeleteObjectCommand; options: unknown }> = [];
    const remove = createS3MessageBodyDeleter({
      bucket: "bucket",
      client: {
        send: async (command, options) => {
          calls.push({ command: command as unknown as DeleteObjectCommand, options });
          return {};
        },
      } as Pick<S3Client, "send">,
    });
    const input = bodyWrite("delete body");
    const signal = new AbortController().signal;
    await remove({
      bodyRef: {
        bucket: "bucket",
        byteSize: input.body.length,
        contentType: "text/plain; charset=utf-8",
        key: messageBodyKey(input.contentHash),
        sha256: input.contentHash,
        versionId: "version",
      },
      messageId: input.messageId,
      run: input.run,
      signal,
    });
    expect(calls[0]?.command.input).toEqual({
      Bucket: "bucket",
      Key: messageBodyKey(input.contentHash),
      VersionId: "version",
    });
    expect(calls[0]?.options).toEqual({ abortSignal: signal });
  });

  it("deletes a persisted body from an explicitly retained legacy bucket", async () => {
    const input = bodyWrite("legacy delete body");
    const commands: DeleteObjectCommand[] = [];
    const remove = createS3MessageBodyDeleter({
      bucket: "current-bucket",
      client: {
        send: async (command) => {
          commands.push(command as unknown as DeleteObjectCommand);
          return {};
        },
      } as Pick<S3Client, "send">,
      legacyBuckets: ["legacy-bucket"],
    });

    await remove({
      bodyRef: {
        bucket: "legacy-bucket",
        byteSize: input.body.length,
        contentType: "text/plain; charset=utf-8",
        key: messageBodyKey(input.contentHash),
        sha256: input.contentHash,
        versionId: "version",
      },
      messageId: input.messageId,
      run: input.run,
    });

    expect(commands[0]?.input.Bucket).toBe("legacy-bucket");
  });

  it("rejects cross-bucket and cross-scope keys before deletion", async () => {
    const input = bodyWrite("delete body");
    let sends = 0;
    const remove = createS3MessageBodyDeleter({
      bucket: "bucket",
      client: {
        send: async () => {
          sends += 1;
          return {};
        },
      } as Pick<S3Client, "send">,
    });
    const reference = {
      bucket: "other",
      byteSize: 1,
      contentType: "text/plain",
      key: "wrong",
      sha256: input.contentHash,
      versionId: "version",
    };
    expect(
      remove({ bodyRef: reference, messageId: input.messageId, run: input.run }),
    ).rejects.toThrow("unexpected S3 bucket");
    expect(
      remove({
        bodyRef: { ...reference, bucket: "bucket" },
        messageId: input.messageId,
        run: input.run,
      }),
    ).rejects.toThrow("unexpected S3 object key");
    expect(sends).toBe(0);
  });

  it("requires a concrete version and honors a custom prefix", async () => {
    const input = bodyWrite("delete body");
    const commands: DeleteObjectCommand[] = [];
    const remove = createS3MessageBodyDeleter({
      bucket: "bucket",
      keyPrefix: "custom",
      client: {
        send: async (command) => {
          commands.push(command as unknown as DeleteObjectCommand);
          return {};
        },
      } as Pick<S3Client, "send">,
    });
    const key = messageBodyKey(input.contentHash, { prefix: "custom" });
    expect(
      remove({
        bodyRef: {
          bucket: "bucket",
          byteSize: 1,
          contentType: "text/plain",
          key,
          sha256: input.contentHash,
        },
        messageId: input.messageId,
        run: input.run,
      }),
    ).rejects.toThrow("versionId is required");
    await remove({
      bodyRef: {
        bucket: "bucket",
        byteSize: 1,
        contentType: "text/plain",
        key,
        sha256: input.contentHash,
        versionId: "version",
      },
      messageId: input.messageId,
      run: input.run,
    });
    expect(commands).toHaveLength(1);
  });
});
