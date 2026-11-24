import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { MAX_SANDBOX_WORKSPACE_SNAPSHOT_BYTES } from "@deployments-ai/db";
import type { ThreadSandboxScope } from "./contracts.ts";

const THREAD_SANDBOX_SNAPSHOT_CONTENT_TYPE = "application/gzip";
/** S3 checks presigned expiry only when a request starts, so this bounds start time, not duration. */
const THREAD_SANDBOX_PRESIGNED_URL_TTL_SECONDS = 900;

/** Immutable reference to one committed workspace archive version. */
export interface ThreadSandboxSnapshotRef {
  readonly bucket: string;
  readonly byteSize: number;
  readonly key: string;
  /** Lowercase hex SHA-256 of the archive bytes. */
  readonly sha256: string;
  readonly versionId: string;
}

interface ThreadSandboxSnapshotUpload {
  /** Every signed header the sandbox must send verbatim with the `PUT`. */
  readonly headers: Readonly<Record<string, string>>;
  readonly url: string;
}

interface SnapshotObject {
  readonly byteSize: number;
  readonly key: string;
  readonly sha256: string;
}

export interface ThreadSandboxSnapshotStore {
  /** Verifies the uploaded object's size, SHA-256, and KMS encryption; returns its version. */
  readonly confirmUpload: (
    object: SnapshotObject,
    signal?: AbortSignal,
  ) => Promise<ThreadSandboxSnapshotRef>;
  readonly delete: (ref: ThreadSandboxSnapshotRef, signal?: AbortSignal) => Promise<void>;
  /** Presigns a `GetObject` of the exact archive version. */
  readonly presignDownload: (ref: ThreadSandboxSnapshotRef) => Promise<string>;
  /**
   * Presigns a create-only (`If-None-Match: *`), SSE-KMS `PutObject` whose signed
   * `x-amz-checksum-sha256` makes S3 reject any body other than the archive already hashed.
   */
  readonly presignUpload: (object: SnapshotObject) => Promise<ThreadSandboxSnapshotUpload>;
}

export class ThreadSandboxSnapshotIntegrityError extends Error {
  override readonly name = "ThreadSandboxSnapshotIntegrityError";
}

export function threadSandboxSnapshotKey(
  scope: Pick<
    ThreadSandboxScope,
    | "environmentId"
    | "executionTargetId"
    | "executionTargetKind"
    | "organizationId"
    | "projectId"
    | "threadId"
  >,
  snapshotId: string,
) {
  return [
    "organizations",
    scope.organizationId,
    "sandbox-workspaces",
    "projects",
    scope.projectId,
    "environments",
    scope.environmentId,
    "threads",
    scope.threadId,
    "execution-targets",
    scope.executionTargetKind,
    scope.executionTargetId,
    `${snapshotId}.tar.gz`,
  ].join("/");
}

function required(value: string, label: string) {
  const trimmed = value.trim();
  if (!trimmed) throw new TypeError(`Thread sandbox snapshot ${label} is required.`);
  return trimmed;
}

function requireObject(object: SnapshotObject) {
  if (
    !Number.isSafeInteger(object.byteSize) ||
    object.byteSize < 1 ||
    object.byteSize > MAX_SANDBOX_WORKSPACE_SNAPSHOT_BYTES
  ) {
    throw new ThreadSandboxSnapshotIntegrityError(
      "Workspace snapshot size is outside the supported range.",
    );
  }
  if (!/^[0-9a-f]{64}$/u.test(object.sha256)) {
    throw new ThreadSandboxSnapshotIntegrityError("Workspace snapshot digest is malformed.");
  }
  return Buffer.from(object.sha256, "hex").toString("base64");
}

export function createS3ThreadSandboxSnapshotStore(options: {
  readonly bucket: string;
  readonly client: S3Client;
  readonly kmsKeyId: string;
}): ThreadSandboxSnapshotStore {
  const bucket = required(options.bucket, "bucket");
  const kmsKeyId = required(options.kmsKeyId, "KMS key");
  const { client } = options;

  return {
    confirmUpload: async (object, signal) => {
      const checksum = requireObject(object);
      const head = await client.send(
        new HeadObjectCommand({ Bucket: bucket, ChecksumMode: "ENABLED", Key: object.key }),
        signal ? { abortSignal: signal } : {},
      );
      const versionId = head.VersionId?.trim();
      if (
        head.ContentLength !== object.byteSize ||
        head.ChecksumSHA256 !== checksum ||
        head.ServerSideEncryption !== "aws:kms" ||
        head.SSEKMSKeyId !== kmsKeyId ||
        !versionId
      ) {
        throw new ThreadSandboxSnapshotIntegrityError(
          "Uploaded workspace snapshot does not match its archive.",
        );
      }
      return {
        bucket,
        byteSize: object.byteSize,
        key: object.key,
        sha256: object.sha256,
        versionId,
      };
    },
    delete: async (ref, signal) => {
      await client.send(
        new DeleteObjectCommand({ Bucket: ref.bucket, Key: ref.key, VersionId: ref.versionId }),
        signal ? { abortSignal: signal } : {},
      );
    },
    presignDownload: (ref) =>
      getSignedUrl(
        client,
        new GetObjectCommand({ Bucket: ref.bucket, Key: ref.key, VersionId: ref.versionId }),
        { expiresIn: THREAD_SANDBOX_PRESIGNED_URL_TTL_SECONDS },
      ),
    presignUpload: async (object) => {
      const checksum = requireObject(object);
      const headers = {
        "content-type": THREAD_SANDBOX_SNAPSHOT_CONTENT_TYPE,
        "if-none-match": "*",
        "x-amz-checksum-sha256": checksum,
        "x-amz-server-side-encryption": "aws:kms",
        "x-amz-server-side-encryption-aws-kms-key-id": kmsKeyId,
      };
      const url = await getSignedUrl(
        client,
        new PutObjectCommand({
          Bucket: bucket,
          ChecksumSHA256: checksum,
          ContentType: THREAD_SANDBOX_SNAPSHOT_CONTENT_TYPE,
          IfNoneMatch: "*",
          Key: object.key,
          ServerSideEncryption: "aws:kms",
          SSEKMSKeyId: kmsKeyId,
        }),
        {
          expiresIn: THREAD_SANDBOX_PRESIGNED_URL_TTL_SECONDS,
          // Signed as headers (not hoisted into the query) so S3 enforces each one.
          signableHeaders: new Set(Object.keys(headers)),
          unhoistableHeaders: new Set(
            Object.keys(headers).filter((name) => name.startsWith("x-amz-")),
          ),
        },
      );
      return { headers, url };
    },
  };
}
