import { GetObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import {
  inputFileTextKey,
  RunInputArtifactError,
  type ReadableAttachment,
} from "@deployments-ai/db";
import { artifactBucketAllowed } from "./artifact-buckets.ts";
import { readBoundedS3BodyBytes } from "./s3.ts";

export interface InputFileStorage {
  readonly bucket: string;
  readonly client: Pick<S3Client, "send">;
  readonly legacyBuckets?: readonly string[];
}

export interface InputFileTextPage {
  readonly startByte: number;
  readonly endByte: number;
  readonly text: string;
}

export function isContinuationByte(byte: number | undefined): boolean {
  return byte !== undefined && (byte & 0xc0) === 0x80;
}

const MAX_UTF8_CHARACTER_BYTES = 4;
const MIN_PAGE_REACH_BYTES = MAX_UTF8_CHARACTER_BYTES - 1 + MAX_UTF8_CHARACTER_BYTES;

export async function readInputFileText(
  source: InputFileStorage,
  read: {
    readonly attachment: ReadableAttachment;
    readonly maxBytes: number;
    readonly signal?: AbortSignal | undefined;
    readonly startByte: number;
  },
): Promise<InputFileTextPage> {
  const { file, record } = read.attachment;
  const textBytes = file.text.byteSize;
  if (read.startByte >= textBytes) return { endByte: textBytes, startByte: textBytes, text: "" };
  const { bucket, sha256 } = record.data.storage;
  if (!artifactBucketAllowed(bucket, source.bucket, source.legacyBuckets)) {
    throw new RunInputArtifactError(
      "input_artifact_unavailable",
      "Input file text is outside the artifact buckets.",
    );
  }
  const byteAfterPage = Math.min(
    read.startByte + Math.max(read.maxBytes, MIN_PAGE_REACH_BYTES),
    textBytes - 1,
  );
  const response = await source.client.send(
    new GetObjectCommand({
      Bucket: bucket,
      Key: inputFileTextKey(record.data, record.data.id, sha256),
      Range: `bytes=${read.startByte}-${byteAfterPage}`,
      VersionId: file.text.versionId,
    }),
    read.signal ? { abortSignal: read.signal } : {},
  );
  if (response.VersionId !== file.text.versionId) {
    throw new RunInputArtifactError(
      "input_artifact_unavailable",
      "Input file text does not match its extracted version.",
    );
  }
  const bytes = await readBoundedS3BodyBytes(
    response.Body,
    byteAfterPage - read.startByte + 1,
    response.ContentLength,
  );
  let start = 0;
  while (isContinuationByte(bytes[start])) start += 1;
  let end = Math.max(start, Math.min(bytes.byteLength, read.maxBytes));
  while (end > start && isContinuationByte(bytes[end])) end -= 1;
  if (end === start && start < bytes.byteLength) {
    end += 1;
    while (isContinuationByte(bytes[end])) end += 1;
  }
  return {
    endByte: read.startByte + end,
    startByte: read.startByte + start,
    text: new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(start, end)),
  };
}
