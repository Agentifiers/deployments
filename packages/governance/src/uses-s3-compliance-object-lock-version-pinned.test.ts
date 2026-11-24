import { SignCommand, type KMSClient } from "@aws-sdk/client-kms";
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectVersionsCommand,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { describe, expect, test } from "bun:test";
import { makeKmsGovernanceSigner, makeS3GovernanceObjectStore } from "./aws.ts";
import { sha256 } from "./canonical.ts";
import { GovernanceObjectNotFoundError } from "./types.ts";

describe("governance AWS adapters", () => {
  test("uses S3 Compliance Object Lock and version-pinned encrypted writes for audit exports", async () => {
    const commands: unknown[] = [];
    const store = makeS3GovernanceObjectStore({
      bucket: "governance",
      client: {
        send: async (command: unknown) => {
          commands.push(command);
          return { ETag: '"etag"', VersionId: "version-1" };
        },
      } as Pick<S3Client, "send">,
      kmsKeyArn: "arn:aws:kms:us-east-2:123456789012:key/artifacts",
    });
    const body = new TextEncoder().encode("immutable audit export");

    const reference = await store.put({
      body,
      contentType: "application/x-ndjson",
      immutable: true,
      key: "governance/org/audit.jsonl",
      retainUntil: "2033-07-23T00:00:00.000Z",
      sha256: sha256(body),
    });

    const command = commands[0] as PutObjectCommand;
    expect(command).toBeInstanceOf(PutObjectCommand);
    expect(command.input).toMatchObject({
      Bucket: "governance",
      IfNoneMatch: "*",
      ObjectLockMode: "COMPLIANCE",
      ServerSideEncryption: "aws:kms",
      SSEKMSKeyId: "arn:aws:kms:us-east-2:123456789012:key/artifacts",
    });
    expect(reference).toMatchObject({ versionId: "version-1", sha256: sha256(body) });
  });

  test("places an encrypted current-version barrier in front of stale artifact uploads", async () => {
    const commands: unknown[] = [];
    const store = makeS3GovernanceObjectStore({
      bucket: "governance",
      client: {
        send: async (command: unknown) => {
          commands.push(command);
          return { VersionId: "barrier-version" };
        },
      } as Pick<S3Client, "send">,
      kmsKeyArn: "arn:aws:kms:us-east-2:123456789012:key/artifacts",
    });

    await store.blockWrites({ bucket: "artifacts", key: "organizations/org/upload.txt" });

    expect(commands[0]).toBeInstanceOf(PutObjectCommand);
    expect((commands[0] as PutObjectCommand).input).toMatchObject({
      Bucket: "artifacts",
      ContentLength: 0,
      ContentType: "application/x-deployments-ai-erasure-barrier",
      Key: "organizations/org/upload.txt",
      ServerSideEncryption: "aws:kms",
      SSEKMSKeyId: "arn:aws:kms:us-east-2:123456789012:key/artifacts",
    });
    expect((commands[0] as PutObjectCommand).input.IfNoneMatch).toBeUndefined();
  });

  test("reuses an identical version-pinned object after a conditional retry", async () => {
    const commands: unknown[] = [];
    const retainedUntil = new Date("2033-07-23T00:00:00.000Z");
    const body = new TextEncoder().encode("retry-safe audit export");
    const digest = sha256(body);
    const store = makeS3GovernanceObjectStore({
      bucket: "governance",
      client: {
        send: async (command) => {
          commands.push(command);
          if (command instanceof PutObjectCommand) {
            throw Object.assign(new Error("already exists"), {
              $metadata: { httpStatusCode: 412 },
              name: "PreconditionFailed",
            });
          }
          return {
            ContentLength: body.byteLength,
            ContentType: "application/x-ndjson",
            ETag: '"existing"',
            Metadata: { sha256: digest },
            ObjectLockMode: "COMPLIANCE",
            ObjectLockRetainUntilDate: retainedUntil,
            VersionId: "existing-version",
          };
        },
      } as Pick<S3Client, "send">,
      kmsKeyArn: "arn:aws:kms:us-east-2:123456789012:key/artifacts",
    });

    expect(
      store.put({
        body,
        contentType: "application/x-ndjson",
        immutable: true,
        key: "governance/org/retry.jsonl",
        retainUntil: retainedUntil.toISOString(),
        sha256: digest,
      }),
    ).resolves.toMatchObject({
      etag: '"existing"',
      versionId: "existing-version",
    });
    expect(commands[1]).toBeInstanceOf(HeadObjectCommand);
  });

  test("resolves a pinned object size before export buffering", async () => {
    const commands: unknown[] = [];
    const store = makeS3GovernanceObjectStore({
      bucket: "governance",
      client: {
        send: async (command) => {
          commands.push(command);
          return { ContentLength: 42 };
        },
      } as Pick<S3Client, "send">,
      kmsKeyArn: "arn:aws:kms:us-east-2:123456789012:key/artifacts",
    });

    expect(
      store.size({
        bucket: "artifacts",
        key: "organizations/org/blob",
        versionId: "version-1",
      }),
    ).resolves.toBe(42);
    expect(commands[0]).toBeInstanceOf(HeadObjectCommand);
    expect((commands[0] as HeadObjectCommand).input).toMatchObject({
      Bucket: "artifacts",
      Key: "organizations/org/blob",
      VersionId: "version-1",
    });
  });

  test("normalizes missing pinned objects for race-tolerant export reads", async () => {
    const commands: unknown[] = [];
    const store = makeS3GovernanceObjectStore({
      bucket: "governance",
      client: {
        send: async (command) => {
          commands.push(command);
          throw { name: "NoSuchVersion" };
        },
      } as Pick<S3Client, "send">,
      kmsKeyArn: "arn:aws:kms:us-east-2:123456789012:key/artifacts",
    });
    const reference = {
      bucket: "artifacts",
      key: "organizations/org/deleted-blob",
      versionId: "deleted-version",
    };

    expect(store.size(reference)).rejects.toBeInstanceOf(GovernanceObjectNotFoundError);
    expect(store.read(reference)).rejects.toBeInstanceOf(GovernanceObjectNotFoundError);
    expect(commands[0]).toBeInstanceOf(HeadObjectCommand);
    expect(commands[1]).toBeInstanceOf(GetObjectCommand);
  });

  test("enumerates and deletes every object version and delete marker for erasure", async () => {
    const commands: unknown[] = [];
    const store = makeS3GovernanceObjectStore({
      bucket: "governance",
      client: {
        send: async (command) => {
          commands.push(command);
          if (command instanceof ListObjectVersionsCommand) {
            return {
              DeleteMarkers: [{ Key: "tenant/blob", VersionId: "marker-1" }],
              IsTruncated: false,
              Versions: [
                { Key: "tenant/blob", VersionId: "version-2" },
                { Key: "tenant/blob", VersionId: "version-1" },
                { Key: "tenant/blob-other", VersionId: "unrelated" },
              ],
            };
          }
          return {};
        },
      } as Pick<S3Client, "send">,
      kmsKeyArn: "arn:aws:kms:us-east-2:123456789012:key/artifacts",
    });

    await store.deleteAllVersions({ bucket: "artifacts", key: "tenant/blob" });

    expect(commands[0]).toBeInstanceOf(ListObjectVersionsCommand);
    expect(commands[1]).toBeInstanceOf(DeleteObjectsCommand);
    expect((commands[1] as DeleteObjectsCommand).input.Delete?.Objects).toEqual([
      { Key: "tenant/blob", VersionId: "version-2" },
      { Key: "tenant/blob", VersionId: "version-1" },
      { Key: "tenant/blob", VersionId: "marker-1" },
    ]);
  });

  test("deletes every version beneath a tenant-scoped object prefix", async () => {
    const commands: unknown[] = [];
    const store = makeS3GovernanceObjectStore({
      bucket: "governance",
      client: {
        send: async (command) => {
          commands.push(command);
          if (command instanceof ListObjectVersionsCommand) {
            return {
              DeleteMarkers: [
                { Key: "organizations/org/quarantine-b.json", VersionId: "marker-1" },
              ],
              IsTruncated: false,
              Versions: [
                { Key: "organizations/org/quarantine-a.json", VersionId: "version-1" },
                { Key: "organizations/other/quarantine.json", VersionId: "unrelated" },
              ],
            };
          }
          return {};
        },
      } as Pick<S3Client, "send">,
      kmsKeyArn: "arn:aws:kms:us-east-2:123456789012:key/artifacts",
    });

    await store.deleteAllVersionsUnderPrefix?.({
      bucket: "observability-quarantine",
      keyPrefix: "organizations/org/",
    });

    expect((commands[0] as ListObjectVersionsCommand).input).toMatchObject({
      Bucket: "observability-quarantine",
      Prefix: "organizations/org/",
    });
    expect((commands[1] as DeleteObjectsCommand).input.Delete?.Objects).toEqual([
      { Key: "organizations/org/quarantine-a.json", VersionId: "version-1" },
      { Key: "organizations/org/quarantine-b.json", VersionId: "marker-1" },
    ]);
  });

  test("signs manifest digests without sending plaintext to KMS", async () => {
    const commands: unknown[] = [];
    const signer = makeKmsGovernanceSigner({
      client: {
        send: async (command) => {
          commands.push(command);
          return { Signature: new Uint8Array([1, 2, 3]) };
        },
      } as Pick<KMSClient, "send">,
      keyId: "arn:aws:kms:us-east-2:123456789012:key/signing",
      signingAlgorithm: "ECDSA_SHA_256",
    });
    const digest = new Uint8Array(32).fill(7);

    expect(await signer.sign(digest)).toBe("AQID");
    const command = commands[0] as SignCommand;
    expect(command).toBeInstanceOf(SignCommand);
    expect(command.input).toMatchObject({
      Message: digest,
      MessageType: "DIGEST",
      SigningAlgorithm: "ECDSA_SHA_256",
    });
  });
});
