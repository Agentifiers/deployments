import { expiryReason, readPublishedRecord } from "./catalog.ts";
import { releaseObjectKey, releaseRecordFile, releaseSignatureFile } from "./record.ts";
import type { RegistryStore } from "./store.ts";

async function retainObject(store: RegistryStore, key: string) {
  const tags = await store.getObjectTags(key);
  if (tags.retention === "customer") return false;
  await store.putObjectTags(key, { ...tags, retention: "customer" });
  return true;
}

export async function retainRelease(input: {
  readonly releaseManifestSha256: string;
  readonly store: RegistryStore;
}) {
  const { releaseManifestSha256: digest, store } = input;
  const published = await readPublishedRecord(store, digest);
  if (!published) throw new Error(`Release ${digest} is not published.`);
  const expiry = await expiryReason(store, published.record);
  if (expiry) throw new Error(`Release ${published.record.label} (${digest}) ${expiry}.`);
  const keys = Object.keys(published.record.files).map((file) => releaseObjectKey(digest, file));
  const signatureKey = releaseObjectKey(digest, releaseSignatureFile);
  if (await store.headObject(signatureKey)) keys.push(signatureKey);
  let retagged = 0;
  for (const key of keys) {
    if (await retainObject(store, key)) retagged += 1;
  }
  if (await retainObject(store, releaseObjectKey(digest, releaseRecordFile))) retagged += 1;
  return { objects: keys.length + 1, retagged };
}
