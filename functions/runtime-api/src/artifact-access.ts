import { GetObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { INPUT_ARTIFACT_TYPE } from "@deployments-ai/agent-manifest";
import { type Ulid } from "@deployments-ai/db";
import {
  ExtractionUnavailableError,
  makeS3InputFileObjectStore,
  prepareInputFile,
} from "@deployments-ai/file-text";
import { makeSemanticEventRecord } from "@deployments-ai/events";
import { artifactAccessExpiration, numberValue } from "./request-validation.ts";
import { recordActor } from "./runtime-principal.ts";
import {
  RuntimeApiError,
  publicArtifact,
  type RuntimeApiDependencies,
  type RuntimeApiPrincipal,
} from "./runtime-support.ts";

import {
  PENDING_UPLOAD_CLEANUP_SECONDS,
  artifactKmsKeyArn,
  artifactRetentionExpired,
  loadArtifact,
  missingObject,
  replacement,
  retentionTimestamp,
  type Artifact,
} from "./artifact-storage.ts";

/**
 * Extraction runs inside the request: this deadline plus the client's invoke grace has to fit the
 * runtime API's 29-second timeout with room for the reads and writes around it.
 */
const INPUT_FILE_DEADLINE_MS = 15_000;

async function resolveInputFile(
  dependencies: RuntimeApiDependencies,
  artifact: Artifact,
  versionId: string,
  kmsKeyArn: string,
) {
  try {
    return await prepareInputFile(
      {
        artifactId: artifact.data.id,
        bucket: artifact.data.storage.bucket,
        byteSize: artifact.data.storage.byteSize,
        hint: {
          contentType: artifact.data.storage.contentType,
          fileName: artifact.data.storage.fileName ?? artifact.data.name,
        },
        key: artifact.data.storage.key,
        scope: artifact.data,
        sha256: artifact.data.storage.sha256,
        versionId,
      },
      {
        deadlineMs: INPUT_FILE_DEADLINE_MS,
        extractor: dependencies.fileTextExtractor,
        objects: makeS3InputFileObjectStore({ kmsKeyArn, s3: dependencies.artifactS3 }),
      },
    );
  } catch (cause) {
    if (cause instanceof ExtractionUnavailableError) {
      throw new RuntimeApiError(
        503,
        "input_file_resolution_unavailable",
        "The input file could not be processed yet. Complete the upload again.",
      );
    }
    throw cause;
  }
}

export async function completeArtifactUpload(
  dependencies: RuntimeApiDependencies,
  principal: RuntimeApiPrincipal,
  artifactId: Ulid,
) {
  const current = await loadArtifact(dependencies, principal, artifactId);
  const kmsKeyArn = artifactKmsKeyArn(dependencies);
  if (artifactRetentionExpired(current, dependencies.now?.() ?? new Date())) {
    throw new RuntimeApiError(409, "artifact_retention_expired", "Artifact retention has expired.");
  }
  if (current.data.status === "available") return publicArtifact(current);
  if (current.data.status !== "pending") {
    throw new RuntimeApiError(409, "artifact_unavailable", "Artifact upload cannot be completed.");
  }
  let head;
  try {
    head = await dependencies.artifactS3.send(
      new HeadObjectCommand({
        Bucket: current.data.storage.bucket,
        ChecksumMode: "ENABLED",
        Key: current.data.storage.key,
      }),
    );
  } catch (cause) {
    if (missingObject(cause)) {
      throw new RuntimeApiError(
        409,
        "artifact_upload_incomplete",
        "Artifact bytes have not been uploaded.",
      );
    }
    throw cause;
  }
  const expectedChecksum = Buffer.from(current.data.storage.sha256, "hex").toString("base64");
  if (
    head.ContentLength !== current.data.storage.byteSize ||
    head.ContentType !== current.data.storage.contentType ||
    head.ChecksumSHA256 !== expectedChecksum ||
    head.ServerSideEncryption !== "aws:kms" ||
    head.SSEKMSKeyId !== kmsKeyArn ||
    !head.VersionId?.trim()
  ) {
    throw new RuntimeApiError(
      409,
      "artifact_upload_mismatch",
      "Uploaded artifact bytes do not match the declared size, digest, media type, or encryption policy.",
    );
  }
  const versionId = head.VersionId.trim();
  const input =
    current.data.type === INPUT_ARTIFACT_TYPE
      ? await resolveInputFile(dependencies, current, versionId, kmsKeyArn)
      : undefined;
  const timestamp = (dependencies.now?.() ?? new Date()).toISOString();
  const events =
    current.data.visibility === "private"
      ? []
      : [
          makeSemanticEventRecord({
            actor: recordActor(principal),
            aggregateId: current.data.id,
            aggregateType: "artifact",
            aggregateVersion: 1,
            environmentId: current.data.environmentId,
            eventId: await dependencies.generateId(),
            eventType: "artifact.available",
            occurredAt: timestamp,
            organizationId: current.data.organizationId,
            payload: {
              artifactId: current.data.id,
              byteSize: current.data.storage.byteSize,
              contentType: current.data.storage.contentType,
              ...(current.data.storage.fileName ? { fileName: current.data.storage.fileName } : {}),
              name: current.data.name,
              ...(current.data.runId ? { runId: current.data.runId } : {}),
              status: "available",
              ...(current.data.threadId ? { threadId: current.data.threadId } : {}),
              type: current.data.type,
              visibility: current.data.visibility,
            },
            projectId: current.data.projectId,
          }),
        ];
  try {
    const { uploadExpiresAt: _uploadExpiresAt, ...completedData } = current.data;
    const next = await replacement(
      dependencies,
      current,
      {
        ...completedData,
        ...(input ? { input } : {}),
        status: "available",
        storage: {
          ...current.data.storage,
          ...(head.ETag ? { etag: head.ETag } : {}),
          versionId,
        },
        updatedAt: timestamp,
        version: current.data.version + 1,
      },
      events,
    );
    return publicArtifact(next);
  } catch (cause) {
    if (cause instanceof RuntimeApiError && cause.code === "artifact_version_conflict") {
      const latest = await loadArtifact(dependencies, principal, artifactId);
      if (latest.data.status === "available") return publicArtifact(latest);
    }
    throw cause;
  }
}

/**
 * An attachment header, so a browser saves the file instead of rendering it on the storage origin.
 * The ASCII `filename` drops quotes, backslashes, and control characters; `filename*` keeps the
 * full UTF-8 name.
 */
function attachmentDisposition(artifact: Artifact) {
  const name = artifact.data.storage.fileName ?? artifact.data.name;
  const ascii = Array.from(name)
    .map((character) => {
      const codePoint = character.codePointAt(0)!;
      return codePoint < 0x20 || codePoint > 0x7e || character === '"' || character === "\\"
        ? "_"
        : character;
    })
    .join("");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

export async function createArtifactAccessUrl(
  dependencies: RuntimeApiDependencies,
  principal: RuntimeApiPrincipal,
  artifactId: Ulid,
  body: Readonly<Record<string, unknown>>,
) {
  const current = await loadArtifact(dependencies, principal, artifactId);
  if (current.data.status !== "available") {
    throw new RuntimeApiError(409, "artifact_unavailable", "Artifact is not available.");
  }
  const accessTime = dependencies.now?.() ?? new Date();
  const expiresIn = artifactAccessExpiration(body, {
    now: accessTime,
    ...(current.data.retentionExpiresAt
      ? { retentionExpiresAt: current.data.retentionExpiresAt }
      : {}),
  });
  const grantExpiresAt = new Date(accessTime.getTime() + expiresIn * 1_000).toISOString();
  const latestGrantExpiration =
    current.data.accessUrlExpiresAt &&
    Date.parse(current.data.accessUrlExpiresAt) > Date.parse(grantExpiresAt)
      ? current.data.accessUrlExpiresAt
      : grantExpiresAt;
  await replacement(dependencies, current, {
    ...current.data,
    accessUrlExpiresAt: latestGrantExpiration,
    updatedAt: accessTime.toISOString(),
    version: current.data.version + 1,
  });
  const disposition = body.disposition;
  if (disposition !== undefined && disposition !== "attachment" && disposition !== "inline") {
    throw new RuntimeApiError(400, "invalid_request", "disposition must be attachment or inline.");
  }
  const url = await getSignedUrl(
    dependencies.artifactS3,
    new GetObjectCommand({
      Bucket: current.data.storage.bucket,
      Key: current.data.storage.key,
      ...(disposition === "attachment"
        ? { ResponseContentDisposition: attachmentDisposition(current) }
        : {}),
      VersionId: current.data.storage.versionId,
    }),
    { expiresIn, signingDate: accessTime },
  );
  return { expiresAt: grantExpiresAt, url };
}

export async function updateArtifactRetention(
  dependencies: RuntimeApiDependencies,
  principal: RuntimeApiPrincipal,
  artifactId: Ulid,
  body: Readonly<Record<string, unknown>>,
) {
  const current = await loadArtifact(dependencies, principal, artifactId);
  const expectedVersion = numberValue(body, "expectedVersion");
  if (expectedVersion === undefined || expectedVersion < 0) {
    throw new RuntimeApiError(
      400,
      "invalid_expected_version",
      "expectedVersion must be a non-negative integer.",
    );
  }
  if (current.data.version !== expectedVersion) {
    throw new RuntimeApiError(
      409,
      "artifact_version_conflict",
      "Artifact version does not match expectedVersion.",
    );
  }
  if (!Object.hasOwn(body, "retentionExpiresAt")) {
    throw new RuntimeApiError(
      400,
      "invalid_retention",
      "retentionExpiresAt is required and may be null.",
    );
  }
  const now = dependencies.now?.() ?? new Date();
  if (artifactRetentionExpired(current, now)) {
    throw new RuntimeApiError(
      409,
      "artifact_retention_expired",
      "Artifact retention has expired and cannot be changed.",
    );
  }
  const value = retentionTimestamp(body.retentionExpiresAt, now);
  if (
    value &&
    current.data.accessUrlExpiresAt &&
    Date.parse(value) < Date.parse(current.data.accessUrlExpiresAt)
  ) {
    throw new RuntimeApiError(
      409,
      "artifact_retention_too_soon",
      "retentionExpiresAt cannot precede the expiration of an outstanding access URL.",
    );
  }
  const {
    retentionExpiresAt: _previousRetention,
    uploadExpiresAt: previousUploadExpiresAt,
    ...withoutExpiration
  } = current.data;
  const timestamp = now.toISOString();
  const uploadExpiresAt =
    current.data.status === "pending"
      ? (previousUploadExpiresAt ??
        new Date(now.getTime() + PENDING_UPLOAD_CLEANUP_SECONDS * 1_000).toISOString())
      : undefined;
  const next = await replacement(dependencies, current, {
    ...withoutExpiration,
    ...(value ? { retentionExpiresAt: value } : {}),
    updatedAt: timestamp,
    ...(uploadExpiresAt ? { uploadExpiresAt } : {}),
    version: current.data.version + 1,
  });
  return publicArtifact(next);
}

/**
 * Deletes an artifact for every reader at once: it gets `status: "deleted"` and a retention that
 * ends now, so get and list stop finding it and new download links are refused. A download link already issued
 * works until it expires. Removal then follows retention: DynamoDB TTL removes the record and the
 * retention worker deletes every stored version of the bytes and of any extracted text. A pending
 * upload keeps its upload expiry, so bytes its upload URL still sends are deleted with the rest.
 */
export async function deleteArtifact(
  dependencies: RuntimeApiDependencies,
  principal: RuntimeApiPrincipal,
  artifactId: Ulid,
) {
  const current = await loadArtifact(dependencies, principal, artifactId);
  const now = dependencies.now?.() ?? new Date();
  if (artifactRetentionExpired(current, now)) {
    throw new RuntimeApiError(404, "not_found", "Artifact was not found.");
  }
  const timestamp = now.toISOString();
  const next = await replacement(dependencies, current, {
    ...current.data,
    retentionExpiresAt: timestamp,
    status: "deleted",
    updatedAt: timestamp,
    version: current.data.version + 1,
  });
  return publicArtifact(next);
}
