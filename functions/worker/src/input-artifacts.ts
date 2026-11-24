import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { MAX_PROMPT_DOCUMENT_TEXT_BYTES } from "@deployments-ai/agent-manifest";
import type {
  AgentRunIdentity,
  AgentRuntimeDependencies,
  RuntimeInputArtifact,
  RuntimeTenantScope,
} from "@deployments-ai/agent-runtime";
import {
  customerArtifactStorageKey,
  ingressAttachmentObjectKey,
  loadRunInputArtifacts,
  RunInputArtifactError,
  type ReadableAttachment,
  type RunInputArtifact,
} from "@deployments-ai/db";
import { createHash } from "node:crypto";
import type { S3RuntimeArtifactLoaderOptions } from "./artifacts.ts";
import { artifactBucketAllowed } from "./artifact-buckets.ts";
import { readInputFileText, type InputFileStorage } from "./input-file-text.ts";
import { readBoundedS3BodyBytes } from "./s3.ts";

async function readUploadBytes(
  source: InputFileStorage,
  scope: RuntimeTenantScope & AgentRunIdentity,
  record: RunInputArtifact,
  signal: AbortSignal | undefined,
): Promise<Uint8Array> {
  const storage = record.data.storage;
  const expectedKey =
    record.data.owner?.type === "ingress"
      ? ingressAttachmentObjectKey(scope, record.data.id, storage.sha256)
      : customerArtifactStorageKey(scope, record.data.id, storage.sha256, storage.fileName ?? "");
  if (
    !artifactBucketAllowed(storage.bucket, source.bucket, source.legacyBuckets) ||
    !storage.fileName ||
    storage.key !== expectedKey ||
    !storage.versionId
  ) {
    throw new RunInputArtifactError(
      "input_artifact_unavailable",
      "Input artifact storage does not match its canonical private upload.",
    );
  }
  const response = await source.client.send(
    new GetObjectCommand({
      Bucket: storage.bucket,
      Key: storage.key,
      VersionId: storage.versionId,
      ...(storage.etag ? { IfMatch: storage.etag } : {}),
    }),
    signal ? { abortSignal: signal } : {},
  );
  const bytes = await readBoundedS3BodyBytes(
    response.Body,
    storage.byteSize,
    response.ContentLength,
  );
  if (
    bytes.byteLength !== storage.byteSize ||
    (response.ContentLength !== undefined && response.ContentLength !== bytes.byteLength) ||
    (response.ContentType !== undefined && response.ContentType !== storage.contentType) ||
    response.VersionId !== storage.versionId ||
    createHash("sha256").update(bytes).digest("hex") !== storage.sha256
  ) {
    throw new RunInputArtifactError(
      "input_artifact_unavailable",
      "Input artifact bytes do not match their committed upload.",
    );
  }
  return bytes;
}

export function createS3RunInputArtifactLoader(
  options: S3RuntimeArtifactLoaderOptions & { readonly now?: () => Date },
): NonNullable<AgentRuntimeDependencies["loadInputArtifacts"]> {
  const source: InputFileStorage = {
    bucket: options.bucket,
    client: options.client ?? new S3Client(options.clientConfig ?? {}),
    ...(options.legacyBuckets ? { legacyBuckets: options.legacyBuckets } : {}),
  };
  const heads = new Map<string, Promise<string>>();
  const documentHead = (
    attachment: ReadableAttachment,
    signal: AbortSignal | undefined,
  ): Promise<string> => {
    const key = `${attachment.record.data.id}:${attachment.file.text.versionId}`;
    const cached = heads.get(key);
    if (cached) return cached;
    const head = readInputFileText(source, {
      attachment,
      maxBytes: MAX_PROMPT_DOCUMENT_TEXT_BYTES,
      signal,
      startByte: 0,
    }).then(({ text }) => text);
    heads.set(key, head);
    head.catch(() => heads.delete(key));
    return head;
  };
  return async (input) => {
    const admitted = await loadRunInputArtifacts(options.database, {
      ...input,
      artifactIds: input.media.artifactIds,
      owner: input.media.owner,
      now: options.now?.() ?? new Date(),
    });
    // Sequential bounded reads avoid allocating every maximum-sized object concurrently.
    const artifacts: RuntimeInputArtifact[] = [];
    for (const { file, record } of admitted) {
      input.signal?.throwIfAborted();
      const scope = {
        artifactId: record.data.id,
        messageId: input.media.promptMessageId,
        threadId: input.threadId,
        ...(record.data.retentionExpiresAt
          ? { retentionExpiresAt: record.data.retentionExpiresAt }
          : {}),
      };
      switch (file.kind) {
        case "image":
          artifacts.push({
            ...scope,
            content: await readUploadBytes(source, input, record, input.signal),
            contentType: file.mediaType,
            kind: "image",
          });
          break;
        case "audio":
          artifacts.push({
            ...scope,
            content: await readUploadBytes(source, input, record, input.signal),
            contentType: file.mediaType,
            kind: "audio",
          });
          break;
        case "document":
          artifacts.push({
            ...scope,
            head: await documentHead({ file, record }, input.signal),
            kind: "document",
            name: record.data.name,
            summary: file.summary,
            textBytes: file.text.byteSize,
            truncatedAtExtraction: file.text.truncated,
          });
          break;
        default: {
          const unhandled: never = file;
          throw new Error(`Unhandled input file ${JSON.stringify(unhandled)}`);
        }
      }
      if (
        record.data.retentionExpiresAt &&
        Date.parse(record.data.retentionExpiresAt) <= (options.now?.() ?? new Date()).getTime()
      ) {
        throw new RunInputArtifactError(
          "input_artifact_unavailable",
          "Input artifact retention expired before model use.",
        );
      }
    }
    return artifacts;
  };
}
