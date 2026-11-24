import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  DOCUMENT_TEXT_EXTRACTOR,
  INPUT_AUDIO_MEDIA_TYPES,
  INPUT_IMAGE_MEDIA_TYPES,
  INPUT_MEDIA_SIGNATURE_BYTES,
  inputFileHint,
  sniffInputMediaType,
  type InputFileHint,
} from "@deployments-ai/agent-manifest/input-files";
import {
  inputFileTextKey,
  type ArtifactInputFile,
  type ArtifactStorageScope,
} from "@deployments-ai/db";
import { describeDocument } from "./describe-document.ts";
import type { FileTextExtractor } from "./extraction.ts";
import { MAX_HINT_CONTENT_TYPE_LENGTH, MAX_HINT_FILE_NAME_LENGTH } from "./wire.ts";

export interface InputFileSource {
  readonly scope: ArtifactStorageScope;
  readonly artifactId: string;
  readonly bucket: string;
  /** The canonical customer key the caller already verified. */
  readonly key: string;
  readonly versionId: string;
  readonly sha256: string;
  readonly byteSize: number;
  readonly hint: InputFileHint;
}

export interface InputFileObjectStore {
  readLeadingBytes(source: InputFileSource): Promise<Uint8Array>;
  /** A short-lived GET pinned to the source version, signed for the caller's region. */
  presignSource(source: InputFileSource): Promise<string>;
  /** Create-only; text already stored at the key is reused only when its digest and size match. */
  putTextOnce(text: {
    readonly bucket: string;
    readonly key: string;
    readonly bytes: Uint8Array;
    readonly sha256: string;
  }): Promise<{ readonly versionId: string }>;
}

export interface PrepareInputFileOptions {
  readonly extractor: FileTextExtractor;
  readonly objects: InputFileObjectStore;
  readonly deadlineMs: number;
  readonly signal?: AbortSignal;
}

/**
 * Throws `ExtractionUnavailableError` or an S3 error while the outcome is unknown; the caller then
 * leaves the artifact pending. Rerunning converges on the same resolution and text object.
 */
export async function prepareInputFile(
  source: InputFileSource,
  options: PrepareInputFileOptions,
): Promise<ArtifactInputFile> {
  const contentType = source.hint.contentType
    ?.split(";")[0]
    ?.trim()
    .slice(0, MAX_HINT_CONTENT_TYPE_LENGTH);
  const hint: InputFileHint = {
    ...(contentType ? { contentType } : {}),
    ...(source.hint.fileName === undefined
      ? {}
      : { fileName: source.hint.fileName.slice(-MAX_HINT_FILE_NAME_LENGTH) }),
  };
  if (inputFileHint(hint)?.kind !== "document") {
    const media = sniffInputMediaType(await options.objects.readLeadingBytes(source));
    const image = INPUT_IMAGE_MEDIA_TYPES.find((type) => type === media);
    if (image) return { kind: "image", mediaType: image };
    const audio = INPUT_AUDIO_MEDIA_TYPES.find((type) => type === media);
    if (audio) return { kind: "audio", mediaType: audio };
  }
  const outcome = await options.extractor.extract(
    {
      deadlineMs: options.deadlineMs,
      hint,
      source: {
        byteSize: source.byteSize,
        sha256: source.sha256,
        url: await options.objects.presignSource(source),
      },
    },
    options.signal,
  );
  switch (outcome.status) {
    case "unusable":
      return {
        kind: "unusable",
        reason: outcome.reason,
        ...(outcome.detail ? { detail: outcome.detail } : {}),
      };
    case "text": {
      const { versionId } = await options.objects.putTextOnce({
        bucket: source.bucket,
        bytes: outcome.text,
        key: inputFileTextKey(source.scope, source.artifactId, source.sha256),
        sha256: outcome.textSha256,
      });
      return {
        kind: "document",
        mediaType: outcome.mediaType,
        summary: describeDocument(outcome.mediaType, outcome.facts),
        text: {
          byteSize: outcome.text.byteLength,
          extractor: DOCUMENT_TEXT_EXTRACTOR,
          sha256: outcome.textSha256,
          truncated: outcome.truncated,
          versionId,
        },
      };
    }
    default: {
      const unhandled: never = outcome;
      return unhandled;
    }
  }
}

const SOURCE_URL_SECONDS = 120;

function versionOf(versionId: string | undefined): string {
  if (!versionId?.trim()) throw new Error("Document text was stored without an S3 version.");
  return versionId;
}

function preconditionFailed(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "$metadata" in cause &&
    typeof cause.$metadata === "object" &&
    cause.$metadata !== null &&
    "httpStatusCode" in cause.$metadata &&
    cause.$metadata.httpStatusCode === 412
  );
}

export function makeS3InputFileObjectStore(options: {
  readonly s3: S3Client;
  readonly kmsKeyArn: string;
}): InputFileObjectStore {
  return {
    async readLeadingBytes(source) {
      const response = await options.s3.send(
        new GetObjectCommand({
          Bucket: source.bucket,
          Key: source.key,
          Range: `bytes=0-${INPUT_MEDIA_SIGNATURE_BYTES - 1}`,
          VersionId: source.versionId,
        }),
      );
      return (await response.Body?.transformToByteArray()) ?? new Uint8Array();
    },
    presignSource(source) {
      return getSignedUrl(
        options.s3,
        new GetObjectCommand({
          Bucket: source.bucket,
          Key: source.key,
          VersionId: source.versionId,
        }),
        { expiresIn: SOURCE_URL_SECONDS },
      );
    },
    async putTextOnce(text) {
      const checksum = Buffer.from(text.sha256, "hex").toString("base64");
      try {
        const stored = await options.s3.send(
          new PutObjectCommand({
            Body: text.bytes,
            Bucket: text.bucket,
            ChecksumSHA256: checksum,
            ContentLength: text.bytes.byteLength,
            ContentType: "text/plain; charset=utf-8",
            IfNoneMatch: "*",
            Key: text.key,
            SSEKMSKeyId: options.kmsKeyArn,
            ServerSideEncryption: "aws:kms",
          }),
        );
        return { versionId: versionOf(stored.VersionId) };
      } catch (cause) {
        if (!preconditionFailed(cause)) throw cause;
      }
      const existing = await options.s3.send(
        new HeadObjectCommand({ Bucket: text.bucket, ChecksumMode: "ENABLED", Key: text.key }),
      );
      if (
        existing.ChecksumSHA256 !== checksum ||
        existing.ContentLength !== text.bytes.byteLength
      ) {
        throw new Error("Stored document text differs from this extraction.");
      }
      return { versionId: versionOf(existing.VersionId) };
    },
  };
}
