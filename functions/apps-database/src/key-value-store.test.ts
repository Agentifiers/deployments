import { describe, expect, test } from "bun:test";
import { ConflictException } from "@aws-sdk/client-cloudfront-keyvaluestore";
import { AppDatabaseError, AppId, AppSlug } from "@deployments-ai/app-database";
import { Schema } from "effect";
import { keyValueStoreSlugDirectory, type KeyValueStoreApi } from "./key-value-store.ts";

const slug = Schema.decodeUnknownSync(AppSlug)("orders-app");
const appId = Schema.decodeUnknownSync(AppId)("01J9Z3NDEKTSV4RRFFQ69G5FAV");

function fakeStore(racingWrites: number) {
  const entries = new Map<string, string>();
  const attempts: string[] = [];
  let version = 0;
  let pendingRaces = racingWrites;
  const checkEtag = (ifMatch: string) => {
    if (pendingRaces > 0) {
      pendingRaces -= 1;
      version += 1;
    }
    if (ifMatch !== `etag-${version}`) {
      throw new ConflictException({ $metadata: {}, message: "Resource is not in expected state." });
    }
    version += 1;
  };
  const api: KeyValueStoreApi = {
    currentEtag: async () => `etag-${version}`,
    delete: async ({ ifMatch, key }) => {
      attempts.push(`delete ${key} if ${ifMatch}`);
      checkEtag(ifMatch);
      entries.delete(key);
    },
    put: async ({ ifMatch, key, value }) => {
      attempts.push(`put ${key} if ${ifMatch}`);
      checkEtag(ifMatch);
      entries.set(key, value);
    },
  };
  return { api, attempts, entries };
}

describe("keyValueStoreSlugDirectory", () => {
  test("rereads the ETag and retries after a concurrent write", async () => {
    const store = fakeStore(2);
    const directory = keyValueStoreSlugDirectory(store.api);
    await directory.put(slug, appId);
    expect({ attempts: store.attempts, entries: Object.fromEntries(store.entries) }).toEqual({
      attempts: [
        "put orders-app if etag-0",
        "put orders-app if etag-1",
        "put orders-app if etag-2",
      ],
      entries: { "orders-app": appId },
    });
  });

  test("gives up after the attempt limit with key_value_store_conflict", async () => {
    const store = fakeStore(10);
    const directory = keyValueStoreSlugDirectory(store.api, 3);
    const failure = await directory.remove(slug).then(
      () => null,
      (error: unknown) => error,
    );
    expect({
      attempts: store.attempts,
      failure: failure instanceof AppDatabaseError ? [failure.code, failure.message] : failure,
    }).toEqual({
      attempts: [
        "delete orders-app if etag-0",
        "delete orders-app if etag-1",
        "delete orders-app if etag-2",
      ],
      failure: [
        "key_value_store_conflict",
        "The KeyValueStore entry for orders-app still conflicted with other writes after 3 attempts; retry the request.",
      ],
    });
  });
});
