import { GetPublicKeyCommand, SignCommand, type KMSClient } from "@aws-sdk/client-kms";
import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectVersionsCommand,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import {
  GovernanceObjectNotFoundError,
  type GovernanceObjectStore,
  type GovernanceSigner,
} from "./types.ts";

function isS3ObjectNotFound(cause: unknown) {
  const status =
    cause && typeof cause === "object" && "$metadata" in cause
      ? (cause.$metadata as { httpStatusCode?: unknown }).httpStatusCode
      : undefined;
  const name = cause && typeof cause === "object" && "name" in cause ? String(cause.name) : "";
  return status === 404 || name === "NotFound" || name === "NoSuchKey" || name === "NoSuchVersion";
}

export function makeS3GovernanceObjectStore(options: {
  readonly bucket: string;
  readonly client: Pick<S3Client, "send">;
  readonly kmsKeyArn: string;
}): GovernanceObjectStore {
  async function deleteVersions(reference: {
    readonly bucket: string;
    readonly key: string;
    readonly prefix: boolean;
  }) {
    let keyMarker: string | undefined;
    let hasNextPage = true;
    let versionIdMarker: string | undefined;
    do {
      const listed = await options.client.send(
        new ListObjectVersionsCommand({
          Bucket: reference.bucket,
          KeyMarker: keyMarker,
          Prefix: reference.key,
          VersionIdMarker: versionIdMarker,
        }),
      );
      const objects = [...(listed.Versions ?? []), ...(listed.DeleteMarkers ?? [])]
        .filter(
          (candidate): candidate is typeof candidate & { Key: string; VersionId: string } =>
            typeof candidate.Key === "string" &&
            (reference.prefix
              ? candidate.Key.startsWith(reference.key)
              : candidate.Key === reference.key) &&
            typeof candidate.VersionId === "string",
        )
        .map((candidate) => ({ Key: candidate.Key, VersionId: candidate.VersionId }));
      if (objects.length > 0) {
        const deleted = await options.client.send(
          new DeleteObjectsCommand({
            Bucket: reference.bucket,
            Delete: { Objects: objects, Quiet: true },
          }),
        );
        if (deleted.Errors && deleted.Errors.length > 0) {
          throw new Error(
            `S3 failed to delete every version under ${reference.bucket}/${reference.key}.`,
          );
        }
      }
      keyMarker = listed.NextKeyMarker;
      versionIdMarker = listed.NextVersionIdMarker;
      hasNextPage = listed.IsTruncated === true;
      if (hasNextPage && !keyMarker) {
        throw new Error("S3 returned a truncated version listing without a continuation key.");
      }
    } while (hasNextPage);
  }

  return {
    async blockWrites(reference) {
      // Artifact upload grants carry If-None-Match: *. Establishing an
      // unconditional current version makes S3 reject both stale and
      // concurrently completing conditional PUTs before the final sweep.
      await options.client.send(
        new PutObjectCommand({
          Body: new Uint8Array(),
          Bucket: reference.bucket,
          ContentLength: 0,
          ContentType: "application/x-deployments-ai-erasure-barrier",
          Key: reference.key,
          ServerSideEncryption: "aws:kms",
          SSEKMSKeyId: options.kmsKeyArn,
        }),
      );
    },
    async delete(reference) {
      await options.client.send(
        new DeleteObjectCommand({
          Bucket: reference.bucket,
          Key: reference.key,
          VersionId: reference.versionId,
        }),
      );
    },
    async deleteAllVersions(reference) {
      await deleteVersions({ bucket: reference.bucket, key: reference.key, prefix: false });
    },
    async deleteAllVersionsUnderPrefix(reference) {
      await deleteVersions({ bucket: reference.bucket, key: reference.keyPrefix, prefix: true });
    },
    async find(key) {
      try {
        const existing = await options.client.send(
          new HeadObjectCommand({ Bucket: options.bucket, Key: key }),
        );
        if (
          !existing.VersionId ||
          !existing.Metadata?.sha256 ||
          existing.ContentLength === undefined
        ) {
          throw new Error(`Existing governance object ${options.bucket}/${key} is incomplete.`);
        }
        return {
          bucket: options.bucket,
          ...(existing.ETag ? { etag: existing.ETag } : {}),
          key,
          sha256: existing.Metadata.sha256,
          sizeBytes: existing.ContentLength,
          versionId: existing.VersionId,
        };
      } catch (cause) {
        const status =
          cause && typeof cause === "object" && "$metadata" in cause
            ? (cause.$metadata as { httpStatusCode?: unknown }).httpStatusCode
            : undefined;
        const name =
          cause && typeof cause === "object" && "name" in cause ? String(cause.name) : "";
        if (status === 404 || name === "NotFound" || name === "NoSuchKey") return undefined;
        throw cause;
      }
    },
    async put(input) {
      const checksum = Buffer.from(input.sha256, "hex").toString("base64");
      let result;
      try {
        result = await options.client.send(
          new PutObjectCommand({
            Body: input.body,
            Bucket: options.bucket,
            ChecksumAlgorithm: "SHA256",
            ChecksumSHA256: checksum,
            ContentType: input.contentType,
            IfNoneMatch: "*",
            Key: input.key,
            Metadata: { sha256: input.sha256 },
            ...(input.immutable
              ? {
                  ObjectLockMode: "COMPLIANCE",
                  ObjectLockRetainUntilDate: new Date(input.retainUntil!),
                }
              : {}),
            ServerSideEncryption: "aws:kms",
            SSEKMSKeyId: options.kmsKeyArn,
          }),
        );
      } catch (cause) {
        const status =
          cause && typeof cause === "object" && "$metadata" in cause
            ? (cause.$metadata as { httpStatusCode?: unknown }).httpStatusCode
            : undefined;
        const name =
          cause && typeof cause === "object" && "name" in cause ? String(cause.name) : "";
        if (status !== 412 && name !== "PreconditionFailed") throw cause;
        const existing = await options.client.send(
          new HeadObjectCommand({ Bucket: options.bucket, Key: input.key }),
        );
        const expectedRetainUntil = input.retainUntil ? Date.parse(input.retainUntil) : undefined;
        const actualRetainUntil = existing.ObjectLockRetainUntilDate?.getTime();
        const matches =
          existing.Metadata?.sha256 === input.sha256 &&
          existing.ContentLength === input.body.byteLength &&
          existing.ContentType === input.contentType &&
          (!input.immutable ||
            (existing.ObjectLockMode === "COMPLIANCE" &&
              expectedRetainUntil !== undefined &&
              actualRetainUntil !== undefined &&
              actualRetainUntil >= expectedRetainUntil));
        if (!matches) {
          throw new Error(
            `Existing governance object ${options.bucket}/${input.key} does not match the retry payload.`,
          );
        }
        result = existing;
      }
      if (!result.VersionId) {
        throw new Error("Governance object storage must return an S3 version ID.");
      }
      return {
        bucket: options.bucket,
        ...(result.ETag ? { etag: result.ETag } : {}),
        key: input.key,
        sha256: input.sha256,
        sizeBytes: input.body.byteLength,
        versionId: result.VersionId,
      };
    },
    async read(reference) {
      try {
        const result = await options.client.send(
          new GetObjectCommand({
            Bucket: reference.bucket,
            Key: reference.key,
            VersionId: reference.versionId,
          }),
        );
        if (!result.Body) throw new Error("Governance object body is missing.");
        return result.Body.transformToByteArray();
      } catch (cause) {
        if (isS3ObjectNotFound(cause)) throw new GovernanceObjectNotFoundError(reference);
        throw cause;
      }
    },
    async size(reference) {
      try {
        const result = await options.client.send(
          new HeadObjectCommand({
            Bucket: reference.bucket,
            Key: reference.key,
            VersionId: reference.versionId,
          }),
        );
        if (result.ContentLength === undefined) {
          throw new Error(`Governance object ${reference.bucket}/${reference.key} has no size.`);
        }
        return result.ContentLength;
      } catch (cause) {
        if (isS3ObjectNotFound(cause)) throw new GovernanceObjectNotFoundError(reference);
        throw cause;
      }
    },
  };
}

export function makeKmsGovernanceSigner(options: {
  readonly client: Pick<KMSClient, "send">;
  readonly keyId: string;
  readonly signingAlgorithm: "ECDSA_SHA_256" | "RSASSA_PSS_SHA_256" | "RSASSA_PKCS1_V1_5_SHA_256";
}): GovernanceSigner {
  let publicKey: Promise<string> | undefined;
  return {
    keyId: options.keyId,
    publicKey() {
      if (!publicKey) {
        publicKey = options.client
          .send(new GetPublicKeyCommand({ KeyId: options.keyId }))
          .then((result) => {
            if (!result.PublicKey)
              throw new Error("KMS did not return the audit signing public key.");
            return Buffer.from(result.PublicKey).toString("base64");
          })
          .catch((cause) => {
            publicKey = undefined;
            throw cause;
          });
      }
      return publicKey;
    },
    async sign(digest) {
      const result = await options.client.send(
        new SignCommand({
          KeyId: options.keyId,
          Message: digest,
          MessageType: "DIGEST",
          SigningAlgorithm: options.signingAlgorithm,
        }),
      );
      if (!result.Signature) throw new Error("KMS did not return an audit export signature.");
      return Buffer.from(result.Signature).toString("base64");
    },
  };
}
