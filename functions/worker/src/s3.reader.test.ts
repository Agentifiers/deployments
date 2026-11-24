import { GetObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { createS3MessageBodyReader } from "./s3.ts";
import { id, message, messageBodyKey } from "./s3.fixture.ts";

describe("S3 message body reader", () => {
  it("reads the pinned object version and verifies its integrity", async () => {
    const fixture = message("Blob-backed prompt.");
    const calls: Array<{ readonly command: GetObjectCommand; readonly options: unknown }> = [];
    const client = {
      send: async (command: GetObjectCommand, options?: unknown) => {
        calls.push({ command, options });
        return {
          Body: {
            transformToByteArray: async () => fixture.bytes,
          },
          ContentLength: fixture.bytes.byteLength,
          ContentType: "text/plain; charset=utf-8",
          ETag: '"body-etag"',
          VersionId: "body-version",
        };
      },
    } as Pick<S3Client, "send">;
    const read = createS3MessageBodyReader({
      bucket: "platform-message-bodies",
      client,
    });
    const abort = new AbortController();

    expect(read(fixture.record, abort.signal)).resolves.toBe("Blob-backed prompt.");
    expect(calls[0]?.command.input).toEqual({
      Bucket: "platform-message-bodies",
      IfMatch: "body-etag",
      Key: messageBodyKey(fixture.digest),
      VersionId: "body-version",
    });
    expect(calls[0]?.options).toEqual({ abortSignal: abort.signal });
  });

  it("reads a persisted body from an explicitly retained legacy bucket", async () => {
    const fixture = message("Legacy blob-backed prompt.");
    const commands: GetObjectCommand[] = [];
    const read = createS3MessageBodyReader({
      bucket: "current-bucket",
      client: {
        send: async (command: GetObjectCommand) => {
          commands.push(command);
          return {
            Body: { transformToByteArray: async () => fixture.bytes },
            ContentLength: fixture.bytes.byteLength,
            ContentType: "text/plain; charset=utf-8",
            ETag: '"body-etag"',
            VersionId: "body-version",
          };
        },
      } as Pick<S3Client, "send">,
      legacyBuckets: ["platform-message-bodies"],
    });

    expect(read(fixture.record)).resolves.toBe("Legacy blob-backed prompt.");
    expect(commands[0]?.input.Bucket).toBe("platform-message-bodies");
  });

  it("rejects cross-bucket, oversized, and digest-mismatched references before use", async () => {
    const fixture = message("Blob-backed prompt.");
    let sends = 0;
    const client = {
      send: async () => {
        sends += 1;
        return {};
      },
    } as Pick<S3Client, "send">;
    const read = createS3MessageBodyReader({
      bucket: "another-bucket",
      client,
      maxBodyBytes: fixture.bytes.byteLength - 1,
    });

    expect(read(fixture.record)).rejects.toThrow("unexpected S3 bucket");
    expect(sends).toBe(0);

    const oversized = createS3MessageBodyReader({
      bucket: "platform-message-bodies",
      client,
      maxBodyBytes: fixture.bytes.byteLength - 1,
    });
    expect(oversized(fixture.record)).rejects.toThrow("body size must be from 0");
    expect(sends).toBe(0);

    const mismatched = {
      ...fixture.record,
      data: { ...fixture.record.data, contentHash: "0".repeat(64) },
    };
    const reader = createS3MessageBodyReader({
      bucket: "platform-message-bodies",
      client,
    });
    expect(reader(mismatched)).rejects.toThrow("content hashes do not match");
    expect(sends).toBe(0);
  });

  it("rejects an explicit non-UTF-8 charset before reading the object", async () => {
    const fixture = message("Blob-backed prompt.");
    const record = {
      ...fixture.record,
      data: {
        ...fixture.record.data,
        bodyRef: {
          ...fixture.record.data.bodyRef!,
          contentType: "text/plain; charset=utf-16",
        },
      },
    };
    let sends = 0;
    const reader = createS3MessageBodyReader({
      bucket: "platform-message-bodies",
      client: {
        send: async () => {
          sends += 1;
          return {};
        },
      } as Pick<S3Client, "send">,
    });

    expect(reader(record)).rejects.toThrow("charset must be UTF-8");
    expect(sends).toBe(0);
  });

  it("rejects cross-tenant and cross-prefix object keys before use", async () => {
    const fixture = message("Blob-backed prompt.");
    let sends = 0;
    const reader = createS3MessageBodyReader({
      bucket: "platform-message-bodies",
      client: {
        send: async () => {
          sends += 1;
          return {};
        },
      } as Pick<S3Client, "send">,
    });
    const crossTenant = {
      ...fixture.record,
      data: {
        ...fixture.record.data,
        bodyRef: {
          ...fixture.record.data.bodyRef!,
          key: messageBodyKey(fixture.digest, { organizationId: id(11) }),
        },
      },
    };
    const crossPrefix = {
      ...fixture.record,
      data: {
        ...fixture.record.data,
        bodyRef: {
          ...fixture.record.data.bodyRef!,
          key: messageBodyKey(fixture.digest, { prefix: "other-prefix" }),
        },
      },
    };

    expect(reader(crossTenant)).rejects.toThrow("unexpected S3 object key");
    expect(reader(crossPrefix)).rejects.toThrow("unexpected S3 object key");
    expect(sends).toBe(0);
  });

  it("uses the configured key prefix for reads", async () => {
    const fixture = message("Blob-backed prompt.");
    const record = {
      ...fixture.record,
      data: {
        ...fixture.record.data,
        bodyRef: {
          ...fixture.record.data.bodyRef!,
          key: messageBodyKey(fixture.digest, { prefix: "custom-bodies" }),
        },
      },
    };
    const calls: GetObjectCommand[] = [];
    const reader = createS3MessageBodyReader({
      bucket: "platform-message-bodies",
      client: {
        send: async (command: GetObjectCommand) => {
          calls.push(command);
          return {
            Body: { transformToByteArray: async () => fixture.bytes },
            ContentLength: fixture.bytes.byteLength,
            ContentType: "text/plain; charset=utf-8",
            ETag: '"body-etag"',
            VersionId: "body-version",
          };
        },
      } as Pick<S3Client, "send">,
      keyPrefix: "/custom-bodies/",
    });

    expect(reader(record)).resolves.toBe("Blob-backed prompt.");
    expect(calls[0]?.input.Key).toBe(record.data.bodyRef.key);
  });

  it("rejects object metadata, bytes, and UTF-8 that disagree with the reference", async () => {
    const fixture = message("Blob-backed prompt.");
    const client = {
      send: async () => ({
        Body: {
          transformToByteArray: async () => new Uint8Array([0xff]),
        },
        ContentLength: fixture.bytes.byteLength,
        ContentType: "text/plain; charset=utf-8",
      }),
    } as Pick<S3Client, "send">;
    const read = createS3MessageBodyReader({
      bucket: "platform-message-bodies",
      client,
    });

    expect(read(fixture.record)).rejects.toThrow("body size does not match");

    const invalidUtf8Bytes = new Uint8Array([0xff]);
    const invalidDigest = createHash("sha256").update(invalidUtf8Bytes).digest("hex");
    const invalidUtf8 = {
      ...fixture.record,
      data: {
        ...fixture.record.data,
        bodyRef: {
          ...fixture.record.data.bodyRef!,
          byteSize: 1,
          key: messageBodyKey(invalidDigest),
          sha256: invalidDigest,
        },
        contentHash: invalidDigest,
      },
    };
    const invalidUtf8Reader = createS3MessageBodyReader({
      bucket: "platform-message-bodies",
      client: {
        send: async () => ({
          Body: {
            transformToByteArray: async () => invalidUtf8Bytes,
          },
          ContentLength: 1,
          ContentType: "text/plain; charset=utf-8",
        }),
      } as Pick<S3Client, "send">,
    });
    expect(invalidUtf8Reader(invalidUtf8)).rejects.toThrow("not valid UTF-8");
  });

  it("stops streaming as soon as an object exceeds its referenced size", async () => {
    const fixture = message("x");
    let completedStream = false;
    const read = createS3MessageBodyReader({
      bucket: "platform-message-bodies",
      client: {
        send: async () => ({
          Body: {
            async *[Symbol.asyncIterator]() {
              yield new Uint8Array([0x78]);
              yield new Uint8Array([0x79]);
              completedStream = true;
            },
          },
          ContentType: "text/plain; charset=utf-8",
        }),
      } as Pick<S3Client, "send">,
    });

    expect(read(fixture.record)).rejects.toThrow("exceeds its referenced size");
    expect(completedStream).toBe(false);
  });
});
