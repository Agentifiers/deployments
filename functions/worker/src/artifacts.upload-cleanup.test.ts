import { describe, expect, test } from "bun:test";
import { DeleteObjectCommand, HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import {
  RuntimeArtifactPublicationError,
  RuntimeArtifactValidationError,
} from "@deployments-ai/agent-runtime";
import { type DynamoDatabaseService } from "@deployments-ai/db";
import { createS3RuntimeArtifactRecorder } from "./artifacts.ts";
import { context } from "./artifacts.fixture.ts";

describe("runtime artifact persistence", () => {
  test("deletes the exact uploaded version when the database confirms no commit", async () => {
    const commands: unknown[] = [];
    const database = {
      getRecord: async () => undefined,
      transactWrite: async () => {
        throw new Error("transaction rejected");
      },
    } as unknown as DynamoDatabaseService;
    const recorder = createS3RuntimeArtifactRecorder({
      bucket: "artifact-bucket",
      client: {
        send: async (command: unknown) => {
          commands.push(command);
          return command instanceof PutObjectCommand
            ? { ETag: '"etag"', VersionId: "version-to-delete" }
            : {};
        },
      } as never,
      database,
      kmsKeyId: "arn:aws:kms:us-east-1:123456789012:key/00000000-0000-0000-0000-000000000000",
    });

    expect(
      recorder(
        { content: "artifact body", fileName: "result.txt", label: "Provider result" },
        0,
        context,
      ),
    ).rejects.toBeInstanceOf(RuntimeArtifactPublicationError);

    expect(commands).toHaveLength(2);
    expect(commands[1]).toBeInstanceOf(DeleteObjectCommand);
    expect((commands[1] as DeleteObjectCommand).input).toMatchObject({
      Bucket: "artifact-bucket",
      VersionId: "version-to-delete",
    });
  });

  test("cleans up the uploaded version when artifact record construction is invalid", async () => {
    const commands: unknown[] = [];
    const recorder = createS3RuntimeArtifactRecorder({
      bucket: "artifact-bucket",
      client: {
        send: async (command: unknown) => {
          commands.push(command);
          return command instanceof PutObjectCommand ? { VersionId: "invalid-version" } : {};
        },
      } as never,
      database: {
        getRecord: async () => undefined,
        transactWrite: async () => {
          throw new Error("transaction must not run");
        },
      } as unknown as DynamoDatabaseService,
      kmsKeyId: "arn:aws:kms:us-east-1:123456789012:key/00000000-0000-0000-0000-000000000000",
    });

    expect(
      recorder(
        {
          content: "artifact body",
          fileName: "result.txt",
          label: "Provider result",
          metadata: { invalid: 1n },
        },
        0,
        context,
      ),
    ).rejects.toBeInstanceOf(RuntimeArtifactValidationError);
    expect(commands[1]).toBeInstanceOf(DeleteObjectCommand);
    expect((commands[1] as DeleteObjectCommand).input.VersionId).toBe("invalid-version");
  });

  test("does not delete an S3 version adopted through HEAD reconciliation", async () => {
    const commands: unknown[] = [];
    const body = new TextEncoder().encode("artifact body");
    const recorder = createS3RuntimeArtifactRecorder({
      bucket: "artifact-bucket",
      client: {
        send: async (command: unknown) => {
          commands.push(command);
          if (command instanceof PutObjectCommand) throw new Error("conditional write lost");
          if (command instanceof HeadObjectCommand) {
            return {
              ChecksumSHA256: (commands[0] as PutObjectCommand).input.ChecksumSHA256,
              ContentLength: body.byteLength,
              ContentType: "application/octet-stream",
              SSEKMSKeyId:
                "arn:aws:kms:us-east-1:123456789012:key/00000000-0000-0000-0000-000000000000",
              ServerSideEncryption: "aws:kms",
              VersionId: "adopted-version",
            };
          }
          throw new Error("adopted version must not be deleted");
        },
      } as never,
      database: {
        getRecord: async () => undefined,
        transactWrite: async () => {
          throw new Error("transaction must not run");
        },
      } as unknown as DynamoDatabaseService,
      kmsKeyId: "arn:aws:kms:us-east-1:123456789012:key/00000000-0000-0000-0000-000000000000",
    });

    expect(
      recorder(
        {
          content: body,
          fileName: "result.txt",
          label: "Provider result",
          metadata: { invalid: 1n },
        },
        0,
        context,
      ),
    ).rejects.toBeInstanceOf(RuntimeArtifactValidationError);
    expect(commands).toHaveLength(2);
    expect(commands[0]).toBeInstanceOf(PutObjectCommand);
    expect(commands[1]).toBeInstanceOf(HeadObjectCommand);
  });

  test("rejects an adopted S3 version with a different content type", async () => {
    const commands: unknown[] = [];
    const body = new TextEncoder().encode("artifact body");
    const recorder = createS3RuntimeArtifactRecorder({
      bucket: "artifact-bucket",
      client: {
        send: async (command: unknown) => {
          commands.push(command);
          if (command instanceof PutObjectCommand) throw new Error("conditional write lost");
          return {
            ChecksumSHA256: (commands[0] as PutObjectCommand).input.ChecksumSHA256,
            ContentLength: body.byteLength,
            ContentType: "text/plain",
            SSEKMSKeyId:
              "arn:aws:kms:us-east-1:123456789012:key/00000000-0000-0000-0000-000000000000",
            ServerSideEncryption: "aws:kms",
            VersionId: "different-content-type",
          };
        },
      } as never,
      database: {
        getRecord: async () => undefined,
      } as unknown as DynamoDatabaseService,
      kmsKeyId: "arn:aws:kms:us-east-1:123456789012:key/00000000-0000-0000-0000-000000000000",
    });

    expect(
      recorder({ content: body, fileName: "result.txt", label: "Provider result" }, 0, context),
    ).rejects.toThrow("could not be reconciled");
    expect(commands).toHaveLength(2);
  });

  test("preserves the uploaded version when database reconciliation is ambiguous", async () => {
    const commands: unknown[] = [];
    let reads = 0;
    const database = {
      getRecord: async () => {
        reads += 1;
        if (reads !== 1) throw new Error("consistent read unavailable");
        return undefined;
      },
      transactWrite: async () => {
        throw new Error("transaction timed out");
      },
    } as unknown as DynamoDatabaseService;
    const recorder = createS3RuntimeArtifactRecorder({
      bucket: "artifact-bucket",
      client: {
        send: async (command: unknown) => {
          commands.push(command);
          return { VersionId: "ambiguous-version" };
        },
      } as never,
      database,
      kmsKeyId: "arn:aws:kms:us-east-1:123456789012:key/00000000-0000-0000-0000-000000000000",
    });

    expect(
      recorder(
        { content: "artifact body", fileName: "result.txt", label: "Provider result" },
        0,
        context,
      ),
    ).rejects.toBeInstanceOf(RuntimeArtifactPublicationError);

    expect(commands).toHaveLength(1);
    expect(commands[0]).toBeInstanceOf(PutObjectCommand);
  });

  test("keeps failed exact-version cleanup retryable", async () => {
    const database = {
      getRecord: async () => undefined,
      transactWrite: async () => {
        throw new Error("transaction rejected");
      },
    } as unknown as DynamoDatabaseService;
    const recorder = createS3RuntimeArtifactRecorder({
      bucket: "artifact-bucket",
      client: {
        send: async (command: unknown) => {
          if (command instanceof DeleteObjectCommand) throw new Error("cleanup unavailable");
          return { VersionId: "version-to-clean" };
        },
      } as never,
      database,
      kmsKeyId: "arn:aws:kms:us-east-1:123456789012:key/00000000-0000-0000-0000-000000000000",
    });

    expect(
      recorder(
        { content: "artifact body", fileName: "result.txt", label: "Provider result" },
        0,
        context,
      ),
    ).rejects.toBeInstanceOf(RuntimeArtifactPublicationError);
  });
});
