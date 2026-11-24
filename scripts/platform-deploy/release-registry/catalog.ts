import {
  decodeReleaseRecord,
  releaseObjectKey,
  releaseRecordFile,
  releaseSignatureFile,
  releasesPrefix,
  type ReleaseRecord,
} from "./record.ts";
import { readObjectBytes, type RegistryStore } from "./store.ts";

export interface PublishedRecord {
  readonly bytes: Uint8Array;
  readonly record: ReleaseRecord;
  readonly unverifiedSignature: Uint8Array | undefined;
}

export async function readPublishedRecord(
  store: RegistryStore,
  releaseManifestSha256: string,
): Promise<PublishedRecord | undefined> {
  const key = releaseObjectKey(releaseManifestSha256, releaseRecordFile);
  const bytes = await readObjectBytes(store, key);
  if (!bytes) return undefined;
  let record: ReleaseRecord;
  try {
    record = decodeReleaseRecord(bytes);
  } catch (error) {
    throw new Error(`Invalid ${key}.`, { cause: error });
  }
  if (record.releaseManifestSha256 !== releaseManifestSha256) {
    throw new Error(`${key} names release ${record.releaseManifestSha256}.`);
  }
  const unverifiedSignature = await readObjectBytes(
    store,
    releaseObjectKey(releaseManifestSha256, releaseSignatureFile),
  );
  return { bytes, record, unverifiedSignature };
}

export async function expiryReason(store: RegistryStore, record: ReleaseRecord) {
  const files = Object.keys(record.files);
  let expired = 0;
  for (const file of files) {
    const stored = await store.headObject(releaseObjectKey(record.releaseManifestSha256, file));
    if (!stored) expired += 1;
  }
  return expired === 0
    ? undefined
    : `has expired: the lifecycle removed ${expired} of its ${files.length} files`;
}

export async function listPublishedRecords(store: RegistryStore) {
  const records: PublishedRecord[] = [];
  for (const digest of await store.listChildNames(releasesPrefix)) {
    const published = await readPublishedRecord(store, digest);
    if (published) records.push(published);
  }
  return records;
}
