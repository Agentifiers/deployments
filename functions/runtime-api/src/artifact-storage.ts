import { PutObjectCommand } from "@aws-sdk/client-s3";
import {
  INPUT_ARTIFACT_TYPE,
  INPUT_FILE_PROBLEMS,
  MAX_INPUT_ARTIFACT_BYTES,
} from "@deployments-ai/agent-manifest";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  ArtifactRecord,
  artifactOwnerOf,
  customerArtifactStorageKey,
  DatabaseError,
  Metadata,
  key,
  sameArtifactOwner,
  withCanonicalRecordKeys,
  type PlatformRecord,
  type Ulid,
  runtimeApiPersistence,
} from "@deployments-ai/db";
import { makeSemanticEventRecord, transactWithSemanticEvents } from "@deployments-ai/events";
import { Schema } from "effect";
import { authorizeBrainPublicationArtifact } from "./artifact-brain-publication-access.ts";
import { numberValue, optionalObjectValue } from "./request-validation.ts";
import { runInitiatingCaller } from "./runtime-principal.ts";
import {
  RuntimeApiError,
  assertRecord,
  getRecord,
  id,
  loadRunById,
  loadThread,
  publicArtifact,
  scoped,
  type RuntimeApiDependencies,
  type RuntimeApiPrincipal,
} from "./runtime-support.ts";

export type Artifact = Extract<PlatformRecord, { readonly itemType: "artifact" }>;

const MAX_ARTIFACT_BYTES = 100 * 1024 * 1024;
const MAX_ARTIFACT_METADATA_BYTES = 128 * 1024;
export const PENDING_UPLOAD_CLEANUP_SECONDS = 24 * 60 * 60;
const UPLOAD_EXPIRATION_SECONDS = 15 * 60;
const MEDIA_TYPE = /^[\w!#$&^_.+-]+\/[\w!#$&^_.+-]+(?:\s*;\s*[\w!#$&^_.+-]+=[^;\r\n]+)*$/u;

export function artifactKmsKeyArn(dependencies: RuntimeApiDependencies) {
  if (!dependencies.artifactKmsKeyArn?.trim()) {
    throw new RuntimeApiError(
      503,
      "artifact_upload_unavailable",
      "Customer artifact uploads are not configured.",
    );
  }
  return dependencies.artifactKmsKeyArn.trim();
}

function artifact(value: PlatformRecord | undefined, principal: RuntimeApiPrincipal): Artifact {
  const record = scoped(assertRecord(value, "artifact", "Artifact"), principal);
  if (!artifactReadable(record, principal)) {
    throw new RuntimeApiError(404, "not_found", "Artifact was not found.");
  }
  return record;
}

export function artifactReadable(record: Artifact, principal: RuntimeApiPrincipal) {
  if (record.data.visibility !== "private") return true;
  if (
    record.data.privateAccess === "runtime-only" ||
    record.data.privateAccess === "brain-authorized"
  ) {
    return false;
  }
  if (record.data.owner) {
    return sameArtifactOwner(record.data.owner, artifactOwnerOf(runInitiatingCaller(principal)));
  }
  return record.data.agentDeploymentId !== undefined;
}

export async function loadArtifact(
  dependencies: RuntimeApiDependencies,
  principal: RuntimeApiPrincipal,
  artifactId: Ulid,
) {
  const value = scoped(
    assertRecord(
      await getRecord(dependencies.database, "execution", {
        pk: key("ORG", principal.scope.organizationId, "ENV", principal.scope.environmentId),
        sk: key("ARTIFACT", artifactId),
      }),
      "artifact",
      "Artifact",
    ),
    principal,
  );
  if (value.data.privateAccess === "brain-authorized") {
    await authorizeBrainPublicationArtifact(dependencies, principal, value);
    return value;
  }
  return artifact(value, principal);
}

export function retentionTimestamp(value: unknown, now: Date): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new RuntimeApiError(
      400,
      "invalid_retention",
      "retentionExpiresAt must be a canonical UTC timestamp or null.",
    );
  }
  const milliseconds = Date.parse(value);
  if (
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString() !== value ||
    milliseconds <= now.getTime()
  ) {
    throw new RuntimeApiError(
      400,
      "invalid_retention",
      "retentionExpiresAt must be a future canonical UTC timestamp.",
    );
  }
  return value;
}

function fileName(value: string) {
  const invalid =
    value === "." ||
    value === ".." ||
    new TextEncoder().encode(value).byteLength > 255 ||
    Array.from(value).some((character) => {
      const codePoint = character.codePointAt(0)!;
      return character === "/" || character === "\\" || codePoint <= 0x1f || codePoint === 0x7f;
    });
  if (invalid) {
    throw new RuntimeApiError(
      400,
      "invalid_artifact_file_name",
      "fileName must contain at most 255 UTF-8 bytes without path separators or control characters.",
    );
  }
  return value;
}

function exactString(body: Readonly<Record<string, unknown>>, name: string) {
  const value = body[name];
  if (typeof value !== "string" || !value || value !== value.trim()) {
    throw new RuntimeApiError(
      400,
      "invalid_request",
      `${name} must be a non-empty string without surrounding whitespace.`,
    );
  }
  return value;
}

function boundedText(body: Readonly<Record<string, unknown>>, name: string, maximum: number) {
  const value = exactString(body, name);
  if (Array.from(value).length > maximum) {
    throw new RuntimeApiError(
      400,
      "invalid_request",
      `${name} must not exceed ${maximum} characters.`,
    );
  }
  return value;
}

function sha256(value: string) {
  if (!/^[a-f0-9]{64}$/u.test(value)) {
    throw new RuntimeApiError(
      400,
      "invalid_artifact_digest",
      "sha256 must be a lowercase hexadecimal SHA-256 digest.",
    );
  }
  return value;
}

function contentType(value: string) {
  if (value.length > 255 || !MEDIA_TYPE.test(value)) {
    throw new RuntimeApiError(
      400,
      "invalid_artifact_content_type",
      "contentType must be a valid media type.",
    );
  }
  return value;
}

export function missingObject(cause: unknown) {
  if (!cause || typeof cause !== "object") return false;
  const error = cause as {
    readonly $metadata?: { readonly httpStatusCode?: number };
    readonly name?: string;
  };
  return (
    error.$metadata?.httpStatusCode === 404 ||
    error.name === "NotFound" ||
    error.name === "NoSuchKey"
  );
}

export function artifactRetentionExpired(record: Artifact, now: Date) {
  const expiresAt = record.data.retentionExpiresAt ?? record.data.uploadExpiresAt;
  return expiresAt !== undefined && Date.parse(expiresAt) <= now.getTime();
}

export async function getArtifact(
  dependencies: RuntimeApiDependencies,
  principal: RuntimeApiPrincipal,
  artifactId: Ulid,
) {
  const current = await loadArtifact(dependencies, principal, artifactId);
  if (artifactRetentionExpired(current, dependencies.now?.() ?? new Date())) {
    throw new RuntimeApiError(404, "not_found", "Artifact was not found.");
  }
  return publicArtifact(current);
}

function byteSize(value: number | undefined) {
  if (value === undefined || value < 1 || value > MAX_ARTIFACT_BYTES) {
    throw new RuntimeApiError(
      400,
      "invalid_artifact_size",
      `byteSize must be an integer from 1 to ${MAX_ARTIFACT_BYTES}.`,
    );
  }
  return value;
}

function artifactMetadata(body: Readonly<Record<string, unknown>>) {
  const value = optionalObjectValue(body, "metadata");
  if (!value) return undefined;
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > MAX_ARTIFACT_METADATA_BYTES) {
    throw new RuntimeApiError(
      400,
      "invalid_request",
      `metadata must not exceed ${MAX_ARTIFACT_METADATA_BYTES} encoded bytes.`,
    );
  }
  try {
    return Schema.decodeUnknownSync(Metadata)(value);
  } catch {
    throw new RuntimeApiError(
      400,
      "invalid_request",
      "metadata must contain valid persisted JSON values.",
    );
  }
}

function artifactTtl(data: Artifact["data"]) {
  const expirations = [data.retentionExpiresAt, data.uploadExpiresAt]
    .filter((value): value is string => value !== undefined)
    .map((value) => Date.parse(value));
  return expirations.length > 0 ? Math.floor(Math.max(...expirations) / 1_000) : undefined;
}

export async function replacement(
  dependencies: RuntimeApiDependencies,
  previous: Artifact,
  data: Artifact["data"],
  events: readonly ReturnType<typeof makeSemanticEventRecord>[] = [],
) {
  const ttl = artifactTtl(data);
  const next = Schema.decodeUnknownSync(ArtifactRecord)(
    withCanonicalRecordKeys({
      data,
      itemType: "artifact",
      ...(ttl === undefined ? {} : { ttl }),
    }),
  );
  try {
    await transactWithSemanticEvents(
      dependencies.database,
      [{ kind: "put", previousRecord: previous, record: next }],
      events,
    );
  } catch (cause) {
    if (cause instanceof DatabaseError && cause.reason === "conflict") {
      throw new RuntimeApiError(
        409,
        "artifact_version_conflict",
        "Artifact version changed concurrently.",
      );
    }
    throw cause;
  }
  return next;
}

export async function createArtifactUpload(
  dependencies: RuntimeApiDependencies,
  principal: RuntimeApiPrincipal,
  body: Readonly<Record<string, unknown>>,
) {
  const now = dependencies.now?.() ?? new Date();
  const kmsKeyArn = artifactKmsKeyArn(dependencies);
  const artifactId = await dependencies.generateId();
  const artifactFileName = fileName(boundedText(body, "fileName", 255));
  const digest = sha256(exactString(body, "sha256"));
  const artifactContentType = contentType(boundedText(body, "contentType", 255));
  const artifactByteSize = byteSize(numberValue(body, "byteSize"));
  const artifactType = boundedText(body, "type", 100);
  const runId = body.runId === undefined ? undefined : id(exactString(body, "runId"), "runId");
  const requestedThreadId =
    body.threadId === undefined ? undefined : id(exactString(body, "threadId"), "threadId");
  const run = runId ? await loadRunById(dependencies, principal, runId) : undefined;
  const threadId = requestedThreadId ?? run?.data.threadId;
  if (threadId) await loadThread(dependencies, principal, threadId);
  if (run && threadId !== run.data.threadId) {
    throw new RuntimeApiError(404, "not_found", "Run was not found in the requested thread.");
  }
  const visibility = body.visibility ?? "private";
  if (visibility !== "private" && visibility !== "organization") {
    throw new RuntimeApiError(
      400,
      "invalid_artifact_visibility",
      "visibility must be private or organization.",
    );
  }
  if (artifactType === INPUT_ARTIFACT_TYPE) {
    if (artifactByteSize > MAX_INPUT_ARTIFACT_BYTES) {
      throw new RuntimeApiError(
        413,
        "input_file_too_large",
        `Input file ${artifactFileName} can't be used: ${INPUT_FILE_PROBLEMS.too_large.copy}`,
      );
    }
    if (visibility !== "private") {
      throw new RuntimeApiError(
        400,
        "invalid_artifact_visibility",
        "Run input artifacts must be private.",
      );
    }
  }
  const objectKey = customerArtifactStorageKey(
    principal.scope,
    artifactId,
    digest,
    artifactFileName,
  );
  const timestamp = now.toISOString();
  const expiresAt = retentionTimestamp(body.retentionExpiresAt, now);
  if (expiresAt && Date.parse(expiresAt) < now.getTime() + UPLOAD_EXPIRATION_SECONDS * 1_000) {
    throw new RuntimeApiError(
      400,
      "invalid_retention",
      "retentionExpiresAt must allow the complete 15-minute upload URL lifetime.",
    );
  }
  const accessUrlExpiresAt = new Date(
    now.getTime() + UPLOAD_EXPIRATION_SECONDS * 1_000,
  ).toISOString();
  const uploadExpiresAt = new Date(
    now.getTime() + PENDING_UPLOAD_CLEANUP_SECONDS * 1_000,
  ).toISOString();
  const metadata = artifactMetadata(body);
  const data: Artifact["data"] = {
    accessUrlExpiresAt,
    createdAt: timestamp,
    ...principal.scope,
    id: artifactId,
    ...(metadata ? { metadata } : {}),
    name: boundedText(body, "name", 255),
    ...(run
      ? {
          observability: {
            captureMode: run.data.captureMode,
            ...(run.data.parentSpanId ? { parentSpanId: run.data.parentSpanId } : {}),
            runSpanId: run.data.spanId,
            sessionId: run.data.threadId,
            traceId: run.data.traceId,
            ...(run.data.workspaceId ? { workspaceId: run.data.workspaceId } : {}),
          },
        }
      : {}),
    owner: artifactOwnerOf(runInitiatingCaller(principal)),
    ...(expiresAt ? { retentionExpiresAt: expiresAt } : {}),
    ...(runId ? { runId } : {}),
    status: "pending",
    storage: {
      bucket: dependencies.artifactBucket,
      byteSize: artifactByteSize,
      contentType: artifactContentType,
      fileName: artifactFileName,
      key: objectKey,
      sha256: digest,
    },
    ...(threadId ? { threadId } : {}),
    type: artifactType,
    updatedAt: timestamp,
    uploadExpiresAt,
    uploadUrlExpiresAt: accessUrlExpiresAt,
    version: 0,
    visibility,
  };
  const ttl = artifactTtl(data);
  const record = Schema.decodeUnknownSync(ArtifactRecord)(
    withCanonicalRecordKeys({
      data,
      itemType: "artifact",
      ...(ttl === undefined ? {} : { ttl }),
    }),
  );
  const checksum = Buffer.from(digest, "hex").toString("base64");
  const command = new PutObjectCommand({
    Bucket: dependencies.artifactBucket,
    ChecksumSHA256: checksum,
    ContentLength: artifactByteSize,
    ContentType: artifactContentType,
    IfNoneMatch: "*",
    Key: objectKey,
    Metadata: {
      artifactId,
      environmentId: principal.scope.environmentId,
      organizationId: principal.scope.organizationId,
      projectId: principal.scope.projectId,
      sha256: digest,
    },
    ServerSideEncryption: "aws:kms",
    SSEKMSKeyId: kmsKeyArn,
  });
  const url = await getSignedUrl(dependencies.artifactS3, command, {
    expiresIn: UPLOAD_EXPIRATION_SECONDS,
    signableHeaders: new Set(["content-type"]),
    signingDate: now,
    unhoistableHeaders: new Set(["x-amz-checksum-sha256"]),
  });
  await runtimeApiPersistence.write(
    dependencies.database,
    record,
    "attribute_not_exists(pk) AND attribute_not_exists(sk)",
  );
  return {
    artifact: publicArtifact(record),
    upload: {
      expiresAt: accessUrlExpiresAt,
      headers: {
        "content-length": String(artifactByteSize),
        "content-type": artifactContentType,
        "if-none-match": "*",
        "x-amz-checksum-sha256": checksum,
        "x-amz-server-side-encryption": "aws:kms",
        "x-amz-server-side-encryption-aws-kms-key-id": kmsKeyArn,
      },
      method: "PUT",
      url,
    },
  };
}
