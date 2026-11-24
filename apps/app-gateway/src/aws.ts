import { GetObjectCommand, NoSuchKey, type S3Client } from "@aws-sdk/client-s3";
import type { ClientSecretSource } from "@deployments-ai/web-bff-auth";
import type { ReleaseFiles } from "./rendered-pages.ts";

export function s3ReleaseFiles(input: {
  readonly bucket: string;
  readonly client: S3Client;
}): ReleaseFiles {
  return {
    async document({ appId, document, releaseId }) {
      try {
        const object = await input.client.send(
          new GetObjectCommand({
            Bucket: input.bucket,
            Key: `apps/${appId}/releases/${releaseId}/${document}`,
          }),
        );
        return await object.Body?.transformToString("utf-8");
      } catch (error) {
        if (error instanceof NoSuchKey) return undefined;
        throw error;
      }
    },
  };
}

export function cachedClientSecret(load: () => Promise<string>): ClientSecretSource {
  let current: Promise<string> | undefined;
  return {
    current: () => {
      current ??= load().catch((error: unknown) => {
        current = undefined;
        throw error;
      });
      return current;
    },
    invalidate: () => {
      current = undefined;
    },
  };
}
