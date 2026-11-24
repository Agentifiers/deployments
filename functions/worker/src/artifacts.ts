import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import {
  RuntimeArtifactPublicationError,
  RuntimeArtifactValidationError,
  agentRunActorId,
  runtimeArtifactId,
  runtimeArtifactSummary,
  type AgentRunIdentity,
  type RuntimeObservabilityContext,
  type RuntimeArtifact,
  type RuntimeTenantScope,
} from "@deployments-ai/agent-runtime";
import {
  ArtifactRecord,
  Ulid,
  executionEventPayload,
  key,
  withCanonicalRecordKeys,
  type DynamoDatabaseService,
  type PlatformRecord,
  workerPersistence,
} from "@deployments-ai/db";
import { makeSemanticEventRecord, transactWithSemanticEvents } from "@deployments-ai/events";
import { createThreadStreamEvent, type ThreadStreamEvent } from "@deployments-ai/streaming";
import { Schema } from "effect";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { artifactBucketAllowed } from "./artifact-buckets.ts";

type ArtifactRecordValue = Extract<PlatformRecord, { readonly itemType: "artifact" }>;
type RuntimeArtifactContext = RuntimeTenantScope &
  AgentRunIdentity &
  Partial<RuntimeObservabilityContext>;

export interface S3RuntimeArtifactRecorderOptions {
  readonly appendThreadEvent?: (event: ThreadStreamEvent) => Promise<void>;
  readonly bucket: string;
  readonly client?: Pick<S3Client, "send">;
  readonly clientConfig?: S3ClientConfig;
  readonly database: DynamoDatabaseService;
  readonly kmsKeyId: string;
  readonly now?: () => Date;
}

export interface S3RuntimeArtifactLoaderOptions extends Pick<
  S3RuntimeArtifactRecorderOptions,
  "bucket" | "client" | "clientConfig" | "database"
> {
  readonly legacyBuckets?: readonly string[];
}

const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
const MAX_ARTIFACT_FILE_NAME_BYTES = 240;
const MAX_S3_OBJECT_KEY_BYTES = 1024;
type ArtifactContentEncoding = "binary" | "utf8";

function required(value: string, label: string) {
  const normalized = value.trim();
  if (!normalized) throw new Error(`Runtime artifact ${label} is required.`);
  return normalized;
}

export { runtimeArtifactId } from "@deployments-ai/agent-runtime";

function artifactBytes(artifact: RuntimeArtifact) {
  const bytes =
    typeof artifact.content === "string"
      ? new TextEncoder().encode(artifact.content)
      : artifact.content;
  if (bytes.byteLength > MAX_ARTIFACT_BYTES) {
    throw new Error(`Runtime artifact exceeds ${MAX_ARTIFACT_BYTES} bytes.`);
  }
  return bytes;
}

function artifactContentEncoding(artifact: RuntimeArtifact): ArtifactContentEncoding {
  return typeof artifact.content === "string" ? "utf8" : "binary";
}

function stableMetadata(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableMetadata);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Readonly<Record<string, unknown>>)
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([name, child]) => [name, stableMetadata(child)]),
    );
  }
  return value;
}

function metadataIdentity(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  try {
    return JSON.stringify(stableMetadata(value));
  } catch (cause) {
    throw new RuntimeArtifactValidationError("Runtime artifact metadata is invalid.", { cause });
  }
}

function safeFileName(value: string) {
  let name = "";
  for (const character of required(value, "fileName")) {
    const codePoint = character.codePointAt(0)!;
    const safe =
      character === "/" || character === "\\" || codePoint <= 0x1f || codePoint === 0x7f
        ? "-"
        : character;
    if (new TextEncoder().encode(name + safe).byteLength > MAX_ARTIFACT_FILE_NAME_BYTES) break;
    name += safe;
  }
  if (!name || name === "." || name === "..")
    throw new RuntimeArtifactValidationError("Runtime artifact fileName is invalid.");
  return name;
}

function artifactKey(
  context: RuntimeArtifactContext,
  artifactId: Ulid,
  digest: string,
  fileName: string,
) {
  const value = [
    "artifacts",
    "organizations",
    context.organizationId,
    "projects",
    context.projectId,
    "environments",
    context.environmentId,
    "runs",
    context.runId,
    artifactId,
    digest,
    encodeURIComponent(fileName),
  ].join("/");
  if (new TextEncoder().encode(value).byteLength > MAX_S3_OBJECT_KEY_BYTES) {
    throw new RuntimeArtifactValidationError("Runtime artifact S3 object key is too long.");
  }
  return value;
}

async function existingArtifact(
  database: DynamoDatabaseService,
  context: RuntimeArtifactContext,
  artifactId: Ulid,
) {
  const result = await workerPersistence.read(
    database,
    "execution",
    {
      pk: key("ORG", context.organizationId, "ENV", context.environmentId),
      sk: key("ARTIFACT", artifactId),
    },
    true,
  );
  const value = result;
  if (!value) return undefined;
  if (value.itemType !== "artifact") {
    throw new RuntimeArtifactValidationError("Artifact key resolved to another record type.");
  }
  return value;
}

function streamEvent(record: ArtifactRecordValue, context: RuntimeArtifactContext, eventId: Ulid) {
  return createThreadStreamEvent({
    actor: { id: agentRunActorId(context), type: "agent" },
    artifactId: record.data.id,
    environmentId: context.environmentId,
    eventId,
    eventType: "artifact.available",
    occurredAt: record.data.createdAt,
    organizationId: context.organizationId,
    payload: {
      artifactId: record.data.id,
      byteSize: record.data.storage.byteSize,
      contentType: record.data.storage.contentType,
      fileName: record.data.storage.fileName ?? record.data.name,
      name: record.data.name,
      runId: context.runId,
      type: record.data.type,
      visibility: record.data.visibility,
    },
    projectId: context.projectId,
    runId: context.runId,
    threadId: context.threadId,
  });
}

function artifactRecordMatchesSummary(
  record: ArtifactRecordValue,
  context: RuntimeArtifactContext,
  digest: string,
  objectKey: string,
  summary: ReturnType<typeof runtimeArtifactSummary>,
  contentEncoding: ArtifactContentEncoding,
  sourceMetadata: RuntimeArtifact["metadata"],
) {
  const visibility = summary.visibility ?? "organization";
  const brainPublication = sourceMetadata?.kind === "brain-private-publication";
  const expectedPrivateAccess =
    visibility === "private" ? (brainPublication ? "brain-authorized" : "runtime-only") : undefined;
  const ownerMatches = brainPublication
    ? record.data.owner?.type === "service-account" &&
      record.data.owner.serviceAccountId === sourceMetadata?.initiatingServiceAccountId
    : record.data.owner === undefined;
  const visibilityRank = { organization: 1, private: 0, public: 2 } as const;
  return (
    record.data.runId === context.runId &&
    record.data.name === summary.label &&
    record.data.type === summary.type &&
    record.data.storage.contentType === summary.contentType &&
    record.data.storage.fileName === summary.fileName &&
    record.data.storage.sha256 === digest &&
    record.data.storage.key === objectKey &&
    visibilityRank[record.data.visibility] >= visibilityRank[visibility] &&
    record.data.privateAccess === expectedPrivateAccess &&
    ownerMatches &&
    record.data.metadata?.contentEncoding === contentEncoding &&
    metadataIdentity(record.data.metadata?.source) === metadataIdentity(sourceMetadata)
  );
}

export function createS3RuntimeArtifactRecorder(options: S3RuntimeArtifactRecorderOptions) {
  const bucket = required(options.bucket, "bucket");
  const kmsKeyId = required(options.kmsKeyId, "KMS key");
  const client = options.client ?? new S3Client(options.clientConfig ?? {});

  return async (artifact: RuntimeArtifact, index: number, context: RuntimeArtifactContext) => {
    const artifactId = runtimeArtifactId(context.runId, index);
    const eventId = runtimeArtifactId(context.runId, index, "artifact-event");
    const summary = runtimeArtifactSummary(artifact);
    const brainPublication = artifact.metadata?.kind === "brain-private-publication";
    const initiatingServiceAccountId = brainPublication
      ? artifact.metadata?.initiatingServiceAccountId
      : undefined;
    if (
      brainPublication &&
      (typeof initiatingServiceAccountId !== "string" || !initiatingServiceAccountId.trim())
    ) {
      throw new RuntimeArtifactValidationError(
        "Brain publication artifacts require an initiating service account.",
      );
    }
    const bytes = artifactBytes(artifact);
    const contentEncoding = artifactContentEncoding(artifact);
    const digest = createHash("sha256").update(bytes).digest("hex");
    const checksum = Buffer.from(digest, "hex").toString("base64");
    const fileName = safeFileName(summary.fileName);
    const contentType = summary.contentType;
    const objectKey = artifactKey(context, artifactId, digest, fileName);
    let existing: ArtifactRecordValue | undefined;
    try {
      existing = await existingArtifact(options.database, context, artifactId);
    } catch (cause) {
      if (cause instanceof RuntimeArtifactValidationError) throw cause;
      throw new RuntimeArtifactPublicationError("Runtime artifact lookup failed.", { cause });
    }
    if (existing) {
      if (
        !artifactRecordMatchesSummary(
          existing,
          context,
          digest,
          objectKey,
          summary,
          contentEncoding,
          artifact.metadata,
        )
      ) {
        throw new RuntimeArtifactValidationError(
          "Runtime artifact retry does not match its canonical record.",
        );
      }
      if (options.appendThreadEvent && existing.data.visibility !== "private") {
        try {
          await options.appendThreadEvent(streamEvent(existing, context, eventId));
        } catch (cause) {
          throw new RuntimeArtifactPublicationError(
            "Runtime artifact was persisted but its stream event could not be published.",
            { artifactPersisted: true, cause },
          );
        }
      }
      return;
    }
    let uploaded:
      | {
          readonly createdByInvocation: boolean;
          readonly etag?: string;
          readonly versionId: string;
        }
      | undefined;
    try {
      const response = await client.send(
        new PutObjectCommand({
          Body: bytes,
          Bucket: bucket,
          ChecksumSHA256: checksum,
          ContentType: contentType,
          IfNoneMatch: "*",
          Key: objectKey,
          Metadata: {
            artifactId,
            environmentId: context.environmentId,
            organizationId: context.organizationId,
            projectId: context.projectId,
            runId: context.runId,
            sha256: digest,
            threadId: context.threadId,
          },
          ServerSideEncryption: "aws:kms",
          SSEKMSKeyId: kmsKeyId,
        }),
      );
      if (response.VersionId?.trim()) {
        uploaded = {
          createdByInvocation: true,
          ...(response.ETag ? { etag: response.ETag } : {}),
          versionId: response.VersionId.trim(),
        };
      }
    } catch {
      // Reconcile below. A timed-out conditional write may still have committed.
    }
    if (!uploaded) {
      let head;
      try {
        head = await client.send(
          new HeadObjectCommand({ Bucket: bucket, ChecksumMode: "ENABLED", Key: objectKey }),
        );
      } catch (cause) {
        throw new RuntimeArtifactPublicationError(
          "Runtime artifact S3 write could not be reconciled.",
          { cause },
        );
      }
      if (
        head.ContentLength !== bytes.byteLength ||
        head.ContentType !== contentType ||
        head.ChecksumSHA256 !== checksum ||
        head.ServerSideEncryption !== "aws:kms" ||
        head.SSEKMSKeyId !== kmsKeyId ||
        !head.VersionId?.trim()
      ) {
        throw new RuntimeArtifactPublicationError(
          "Runtime artifact S3 write could not be reconciled.",
        );
      }
      uploaded = {
        createdByInvocation: false,
        ...(head.ETag ? { etag: head.ETag } : {}),
        versionId: head.VersionId.trim(),
      };
    }
    const cleanupUploadedVersion = async (cause: unknown, message: string) => {
      if (!uploaded.createdByInvocation) return;
      try {
        await client.send(
          new DeleteObjectCommand({
            Bucket: bucket,
            Key: objectKey,
            VersionId: uploaded.versionId,
          }),
        );
      } catch (cleanupCause) {
        throw new RuntimeArtifactPublicationError(message, {
          cause: new AggregateError([cause, cleanupCause]),
        });
      }
    };
    const timestamp = (options.now?.() ?? new Date()).toISOString();
    let record: ArtifactRecordValue;
    let event: ReturnType<typeof makeSemanticEventRecord> | undefined;
    try {
      record = Schema.decodeUnknownSync(ArtifactRecord)(
        withCanonicalRecordKeys({
          data: {
            agentDeploymentId: context.agentDeploymentId,
            createdAt: timestamp,
            environmentId: context.environmentId,
            id: artifactId,
            metadata: {
              contentEncoding,
              index,
              label: summary.label,
              ...(artifact.metadata ? { source: artifact.metadata } : {}),
            },
            name: summary.label,
            ...(context.captureMode && context.spanId && context.traceId
              ? {
                  observability: {
                    captureMode: context.captureMode,
                    ...(context.parentSpanId ? { parentSpanId: context.parentSpanId } : {}),
                    runSpanId: context.spanId,
                    sessionId: context.threadId,
                    traceId: context.traceId,
                    ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),
                  },
                }
              : {}),
            organizationId: context.organizationId,
            projectId: context.projectId,
            ...((summary.visibility ?? "organization") === "private"
              ? {
                  privateAccess: brainPublication
                    ? ("brain-authorized" as const)
                    : ("runtime-only" as const),
                }
              : {}),
            ...(brainPublication
              ? {
                  owner: {
                    serviceAccountId: initiatingServiceAccountId as Ulid,
                    type: "service-account" as const,
                  },
                }
              : {}),
            runId: context.runId,
            status: "available" as const,
            storage: {
              bucket,
              byteSize: bytes.byteLength,
              contentType,
              ...(uploaded.etag ? { etag: uploaded.etag } : {}),
              fileName,
              key: objectKey,
              sha256: digest,
              versionId: uploaded.versionId,
            },
            threadId: context.threadId,
            type: summary.type,
            updatedAt: timestamp,
            version: 0,
            visibility: summary.visibility ?? ("organization" as const),
          },
          itemType: "artifact" as const,
        }),
      );
      event =
        record.data.visibility === "private"
          ? undefined
          : makeSemanticEventRecord({
              aggregateId: artifactId,
              aggregateType: "artifact",
              aggregateVersion: 1,
              environmentId: context.environmentId,
              eventId,
              eventType: "artifact.available",
              occurredAt: timestamp,
              organizationId: context.organizationId,
              payload: executionEventPayload(context, {
                byteSize: bytes.byteLength,
                contentType,
                fileName,
                runId: context.runId,
                type: record.data.type,
              }),
              projectId: context.projectId,
            });
    } catch (cause) {
      await cleanupUploadedVersion(
        cause,
        "Runtime artifact validation failed and its exact S3 version could not be cleaned up.",
      );
      throw new RuntimeArtifactValidationError("Runtime artifact record is invalid.", { cause });
    }
    try {
      await transactWithSemanticEvents(
        options.database,
        [{ kind: "put", record }],
        event ? [event] : [],
      );
    } catch (cause) {
      let reconciled: ArtifactRecordValue | undefined;
      try {
        reconciled = await existingArtifact(options.database, context, artifactId);
      } catch (reconciliationCause) {
        throw new RuntimeArtifactPublicationError(
          "Runtime artifact persistence outcome could not be reconciled.",
          { cause: new AggregateError([cause, reconciliationCause]) },
        );
      }
      if (
        reconciled &&
        artifactRecordMatchesSummary(
          reconciled,
          context,
          digest,
          objectKey,
          summary,
          contentEncoding,
          artifact.metadata,
        ) &&
        reconciled.data.storage.versionId === uploaded.versionId
      ) {
        if (options.appendThreadEvent && reconciled.data.visibility !== "private") {
          try {
            await options.appendThreadEvent(streamEvent(reconciled, context, eventId));
          } catch (publicationCause) {
            throw new RuntimeArtifactPublicationError(
              "Runtime artifact was persisted but its stream event could not be published.",
              { artifactPersisted: true, cause: publicationCause },
            );
          }
        }
        return;
      }
      await cleanupUploadedVersion(
        cause,
        "Runtime artifact transaction failed and its exact S3 version could not be cleaned up.",
      );
      throw new RuntimeArtifactPublicationError("Runtime artifact transaction failed.", { cause });
    }
    if (options.appendThreadEvent && record.data.visibility !== "private") {
      try {
        await options.appendThreadEvent(streamEvent(record, context, eventId));
      } catch (cause) {
        throw new RuntimeArtifactPublicationError(
          "Runtime artifact was persisted but its stream event could not be published.",
          { artifactPersisted: true, cause },
        );
      }
    }
  };
}

export function createS3RuntimeArtifactPublicationRetrier(
  options: Pick<S3RuntimeArtifactRecorderOptions, "appendThreadEvent" | "database">,
) {
  return async (index: number, context: RuntimeArtifactContext) => {
    const artifactId = runtimeArtifactId(context.runId, index);
    let record: ArtifactRecordValue | undefined;
    try {
      record = await existingArtifact(options.database, context, artifactId);
    } catch (cause) {
      throw new RuntimeArtifactPublicationError("Runtime artifact retry lookup failed.", {
        artifactPersisted: true,
        cause,
      });
    }
    if (!record || record.data.runId !== context.runId) {
      throw new RuntimeArtifactPublicationError(
        "Runtime artifact retry could not find the persisted artifact.",
        { artifactPersisted: true },
      );
    }
    if (record.data.visibility === "private") return;
    if (!options.appendThreadEvent) {
      throw new RuntimeArtifactPublicationError(
        "Runtime artifact stream publication retry is not configured.",
        { artifactPersisted: true },
      );
    }
    try {
      await options.appendThreadEvent(
        streamEvent(record, context, runtimeArtifactId(context.runId, index, "artifact-event")),
      );
    } catch (cause) {
      throw new RuntimeArtifactPublicationError("Runtime artifact stream event retry failed.", {
        artifactPersisted: true,
        cause,
      });
    }
  };
}

export function createS3RuntimeArtifactLoader(options: S3RuntimeArtifactLoaderOptions) {
  const bucket = required(options.bucket, "bucket");
  const client = options.client ?? new S3Client(options.clientConfig ?? {});

  return async (index: number, context: RuntimeArtifactContext): Promise<RuntimeArtifact> => {
    const artifactId = runtimeArtifactId(context.runId, index);
    let record: ArtifactRecordValue | undefined;
    try {
      record = await existingArtifact(options.database, context, artifactId);
    } catch (cause) {
      throw new RuntimeArtifactPublicationError("Persisted runtime artifact lookup failed.", {
        artifactPersisted: true,
        cause,
      });
    }
    if (
      !record ||
      record.data.organizationId !== context.organizationId ||
      record.data.projectId !== context.projectId ||
      record.data.environmentId !== context.environmentId ||
      record.data.runId !== context.runId ||
      !artifactBucketAllowed(record.data.storage.bucket, bucket, options.legacyBuckets)
    ) {
      throw new RuntimeArtifactValidationError(
        "Persisted runtime artifact does not match the run scope.",
      );
    }
    const fileName = safeFileName(record.data.storage.fileName ?? record.data.name);
    const expectedKey = artifactKey(context, artifactId, record.data.storage.sha256, fileName);
    if (record.data.storage.key !== expectedKey) {
      throw new RuntimeArtifactValidationError(
        "Persisted runtime artifact references an unexpected S3 object key.",
      );
    }
    let response;
    try {
      response = await client.send(
        new GetObjectCommand({
          Bucket: record.data.storage.bucket,
          ...(record.data.storage.etag ? { IfMatch: record.data.storage.etag } : {}),
          Key: expectedKey,
          VersionId: record.data.storage.versionId,
        }),
      );
    } catch (cause) {
      throw new RuntimeArtifactPublicationError("Persisted runtime artifact body loading failed.", {
        artifactPersisted: true,
        cause,
      });
    }
    if (!response.Body) {
      throw new RuntimeArtifactPublicationError("Persisted runtime artifact body is missing.", {
        artifactPersisted: true,
      });
    }
    const bytes = new Uint8Array(await response.Body.transformToByteArray());
    if (
      bytes.byteLength !== record.data.storage.byteSize ||
      bytes.byteLength > MAX_ARTIFACT_BYTES ||
      (response.ContentLength !== undefined && response.ContentLength !== bytes.byteLength) ||
      (response.ContentType !== undefined &&
        response.ContentType !== record.data.storage.contentType) ||
      (response.VersionId !== undefined && response.VersionId !== record.data.storage.versionId) ||
      createHash("sha256").update(bytes).digest("hex") !== record.data.storage.sha256
    ) {
      throw new RuntimeArtifactValidationError(
        "Persisted runtime artifact body does not match its canonical record.",
      );
    }
    const label =
      typeof record.data.metadata?.label === "string" && record.data.metadata.label.trim()
        ? record.data.metadata.label.trim()
        : record.data.name;
    const contentEncoding = record.data.metadata?.contentEncoding;
    let content: string | Uint8Array = bytes;
    if (contentEncoding === "utf8") {
      try {
        content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch (cause) {
        throw new RuntimeArtifactValidationError(
          "Persisted UTF-8 runtime artifact body is invalid.",
          { cause },
        );
      }
    } else if (contentEncoding !== "binary") {
      throw new RuntimeArtifactValidationError(
        "Persisted runtime artifact content encoding is missing or invalid.",
      );
    }
    const source = record.data.metadata?.source;
    if (source !== undefined && (!source || typeof source !== "object" || Array.isArray(source))) {
      throw new RuntimeArtifactValidationError(
        "Persisted runtime artifact source metadata is invalid.",
      );
    }
    return {
      content,
      contentType: record.data.storage.contentType,
      fileName,
      label,
      ...(source ? { metadata: source as Readonly<Record<string, unknown>> } : {}),
      type: record.data.type,
      visibility: record.data.visibility,
    };
  };
}
