import { DeleteObjectsCommand, ListObjectsV2Command, type S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import type { AppObjectStore } from "@deployments-ai/app-database";

export function s3AppObjectStore(client: S3Client): AppObjectStore {
  return {
    deleteObjects: async ({ bucket, keys }) => {
      const { Errors = [] } = await client.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: keys.map((key) => ({ Key: key })), Quiet: true },
        }),
      );
      const [first] = Errors;
      if (first !== undefined) {
        throw new Error(
          `S3 did not delete ${Errors.length} of ${keys.length} objects from ${bucket}, first ${first.Key}: ${first.Code} ${first.Message}`,
        );
      }
    },
    listObjects: async ({ bucket, prefix }) => {
      const { Contents = [] } = await client.send(
        new ListObjectsV2Command({ Bucket: bucket, MaxKeys: 1000, Prefix: prefix }),
      );
      return Contents.flatMap(({ Key }) => (Key === undefined ? [] : [Key]));
    },
    /** Multipart upload, because a COPY stream has no length up front. */
    putObject: async ({ body, bucket, contentType, key }) => {
      await new Upload({
        client,
        params: { Body: body, Bucket: bucket, ContentType: contentType, Key: key },
      }).done();
    },
  };
}
