import "@aws-sdk/signature-v4a";
import {
  ConflictException,
  DeleteKeyCommand,
  DescribeKeyValueStoreCommand,
  PutKeyCommand,
  ResourceNotFoundException,
  type CloudFrontKeyValueStoreClient,
} from "@aws-sdk/client-cloudfront-keyvaluestore";
import { AppDatabaseError, type SlugDirectory } from "@deployments-ai/app-database";

export interface KeyValueStoreApi {
  readonly currentEtag: () => Promise<string>;
  readonly put: (input: {
    readonly key: string;
    readonly value: string;
    readonly ifMatch: string;
  }) => Promise<void>;
  readonly delete: (input: { readonly key: string; readonly ifMatch: string }) => Promise<void>;
}

export function awsKeyValueStoreApi(
  client: CloudFrontKeyValueStoreClient,
  kvsArn: string,
): KeyValueStoreApi {
  return {
    currentEtag: async () => {
      const { ETag } = await client.send(new DescribeKeyValueStoreCommand({ KvsARN: kvsArn }));
      if (ETag === undefined) throw new Error(`KeyValueStore ${kvsArn} returned no ETag.`);
      return ETag;
    },
    delete: async ({ ifMatch, key }) => {
      try {
        await client.send(new DeleteKeyCommand({ IfMatch: ifMatch, Key: key, KvsARN: kvsArn }));
      } catch (error) {
        if (!(error instanceof ResourceNotFoundException)) throw error;
      }
    },
    put: async ({ ifMatch, key, value }) => {
      await client.send(
        new PutKeyCommand({ IfMatch: ifMatch, Key: key, KvsARN: kvsArn, Value: value }),
      );
    },
  };
}

/**
 * Every write names the store-wide ETag. A concurrent write to any key changes it and the service
 * answers ConflictException, so each attempt rereads the ETag before trying again.
 */
export function keyValueStoreSlugDirectory(api: KeyValueStoreApi, maxAttempts = 5): SlugDirectory {
  async function withCurrentEtag(key: string, write: (ifMatch: string) => Promise<void>) {
    for (let attempt = 1; ; attempt += 1) {
      const ifMatch = await api.currentEtag();
      try {
        await write(ifMatch);
        return;
      } catch (error) {
        if (!(error instanceof ConflictException)) throw error;
        if (attempt >= maxAttempts) {
          throw new AppDatabaseError({
            cause: error,
            code: "key_value_store_conflict",
            message: `The KeyValueStore entry for ${key} still conflicted with other writes after ${maxAttempts} attempts; retry the request.`,
          });
        }
      }
    }
  }
  return {
    put: (slug, appId) =>
      withCurrentEtag(slug, (ifMatch) => api.put({ ifMatch, key: slug, value: appId })),
    remove: (slug) => withCurrentEtag(slug, (ifMatch) => api.delete({ ifMatch, key: slug })),
  };
}
