import { createReadStream, ReadStream } from "node:fs";
import {
  GetObjectCommand,
  GetObjectTaggingCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  PutObjectTaggingCommand,
  type S3Client,
  S3ServiceException,
} from "@aws-sdk/client-s3";
import { log } from "../process.ts";
import type { RegistryStore } from "./store.ts";

const uploadAttempts = 4;
const uploadRetryDelayMs = 1_000;
const networkErrorCodes: Readonly<Record<string, true>> = {
  EAI_AGAIN: true,
  ECONNREFUSED: true,
  ECONNRESET: true,
  EHOSTUNREACH: true,
  ENETUNREACH: true,
  EPIPE: true,
  ETIMEDOUT: true,
};

function hasStatus(error: unknown, status: number) {
  return error instanceof S3ServiceException && error.$metadata.httpStatusCode === status;
}

/** S3 reports a full-object SHA-256 as base64; a multipart composite (`…-N`) is not comparable. */
function storedSha256(checksum: string | undefined) {
  return checksum && !checksum.includes("-")
    ? Buffer.from(checksum, "base64").toString("hex")
    : undefined;
}

/**
 * S3 throttles with 503 SlowDown and reports a stalled request body as 400 RequestTimeout. It
 * answers 409 while a conflicting create-only write is in flight, and a retry then gets 412.
 */
function isRetryableUploadError(error: unknown): error is Error {
  if (error instanceof S3ServiceException) {
    const status = error.$metadata.httpStatusCode ?? 0;
    return status >= 500 || status === 409 || error.name === "RequestTimeout";
  }
  return (
    error instanceof Error && "code" in error && networkErrorCodes[String(error.code)] === true
  );
}

export function s3RegistryStore(input: {
  readonly bucket: string;
  readonly client: Pick<S3Client, "send">;
  readonly retryDelayMs?: number;
}): RegistryStore {
  const { bucket, client, retryDelayMs = uploadRetryDelayMs } = input;
  return {
    async getObject(key) {
      try {
        const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        return response.Body?.transformToWebStream();
      } catch (error) {
        if (hasStatus(error, 404)) return undefined;
        throw error;
      }
    },
    async getObjectTags(key) {
      const response = await client.send(new GetObjectTaggingCommand({ Bucket: bucket, Key: key }));
      return Object.fromEntries(
        (response.TagSet ?? []).map(({ Key: name = "", Value: value = "" }) => [name, value]),
      );
    },
    async headObject(key) {
      try {
        const response = await client.send(
          new HeadObjectCommand({ Bucket: bucket, ChecksumMode: "ENABLED", Key: key }),
        );
        return {
          sha256: storedSha256(response.ChecksumSHA256),
          sizeBytes: response.ContentLength ?? 0,
        };
      } catch (error) {
        if (hasStatus(error, 404)) return undefined;
        throw error;
      }
    },
    async listChildNames(prefix) {
      const names: string[] = [];
      let token: string | undefined;
      do {
        const page = await client.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            ContinuationToken: token,
            Delimiter: "/",
            Prefix: prefix,
          }),
        );
        for (const common of page.CommonPrefixes ?? []) {
          if (common.Prefix) names.push(common.Prefix.slice(prefix.length, -1));
        }
        token = page.NextContinuationToken;
      } while (token);
      return names;
    },
    async putObject(object) {
      const { body } = object;
      for (let attempt = 1; ; attempt += 1) {
        // The SDK never resends a stream body, so every attempt opens the file again.
        const upload =
          body.kind === "bytes"
            ? { Body: body.bytes, ContentLength: body.bytes.byteLength }
            : { Body: createReadStream(body.path), ContentLength: body.sizeBytes };
        try {
          await client.send(
            new PutObjectCommand({
              ...upload,
              Bucket: bucket,
              ChecksumAlgorithm: "SHA256",
              ChecksumSHA256: Buffer.from(object.sha256, "hex").toString("base64"),
              IfNoneMatch: "*",
              Key: object.key,
              Tagging: new URLSearchParams(object.tags).toString(),
            }),
          );
          return "created";
        } catch (error) {
          if (hasStatus(error, 412)) return "exists";
          if (!isRetryableUploadError(error)) throw error;
          if (attempt === uploadAttempts) {
            const message = hasStatus(error, 409)
              ? `Another publish is writing ${object.key}; rerun the publish.`
              : `Upload of ${object.key} failed after ${uploadAttempts} attempts.`;
            throw new Error(message, { cause: error });
          }
          log(
            `upload of ${object.key} failed on attempt ${attempt} (${error.name}: ${error.message}); retrying`,
          );
          await Bun.sleep(retryDelayMs * 2 ** (attempt - 1));
        } finally {
          if (upload.Body instanceof ReadStream) upload.Body.destroy();
        }
      }
    },
    async putObjectTags(key, tags) {
      await client.send(
        new PutObjectTaggingCommand({
          Bucket: bucket,
          Key: key,
          Tagging: {
            TagSet: Object.entries(tags).map(([name, value]) => ({ Key: name, Value: value })),
          },
        }),
      );
    },
  };
}
