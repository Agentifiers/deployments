import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { log } from "../process.ts";
import type { PlatformImageName } from "../profiles.ts";
import {
  decodeReleaseManifest,
  releaseManifestFile,
  sha256File,
  verifyReleaseBundle,
  type VerifiedRelease,
} from "../release-bundle.ts";
import { expiryReason } from "./catalog.ts";
import { releaseObjectKey, releaseRecordFile, releaseSignatureFile } from "./record.ts";
import { readObjectBytes, type RegistryStore } from "./store.ts";
import { readTrustedRecord } from "./verify.ts";

async function download(store: RegistryStore, key: string, path: string, sha256: string) {
  const stream = await store.getObject(key);
  if (!stream) throw new Error(`${key} is missing; the release may have expired.`);
  const hasher = createHash("sha256");
  const sink = Bun.file(path).writer();
  for await (const chunk of stream) {
    hasher.update(chunk);
    await sink.write(chunk);
  }
  await sink.end();
  if (hasher.digest("hex") !== sha256) throw new Error(`Checksum mismatch for ${key}.`);
}

export async function fetchRelease(input: {
  readonly bundle: string;
  readonly images: readonly PlatformImageName[] | "all";
  readonly releaseManifestSha256: string;
  readonly signingPublicKeyPath: string | undefined;
  readonly store: RegistryStore;
}): Promise<VerifiedRelease> {
  const { images, releaseManifestSha256: digest, store } = input;
  const directory = resolve(input.bundle);
  const presentManifest = join(directory, releaseManifestFile);
  if (
    (await Bun.file(presentManifest).exists()) &&
    (await sha256File(presentManifest)) !== digest
  ) {
    throw new Error(`${directory} holds a different release; fetch into an empty directory.`);
  }
  const { bytes, record, unverifiedSignature } = await readTrustedRecord(input);
  const expiry = await expiryReason(store, record);
  if (expiry) throw new Error(`Release ${record.label} (${digest}) ${expiry}.`);
  const manifestBytes = await readObjectBytes(store, releaseObjectKey(digest, releaseManifestFile));
  if (!manifestBytes || createHash("sha256").update(manifestBytes).digest("hex") !== digest) {
    throw new Error(`Release ${digest} has no release.json with that digest.`);
  }
  const skipped = new Set(
    Object.entries(decodeReleaseManifest(manifestBytes).images)
      .filter(([name]) => images !== "all" && !images.some((image) => image === name))
      .flatMap(([, image]) => (image.metadata ? [image.file, image.metadata.file] : [image.file])),
  );
  for (const [file, { sha256 }] of Object.entries(record.files)) {
    if (skipped.has(file)) continue;
    const path = join(directory, file);
    await mkdir(dirname(path), { recursive: true });
    await download(store, releaseObjectKey(digest, file), path, sha256);
  }
  await writeFile(join(directory, releaseRecordFile), bytes);
  if (unverifiedSignature) {
    await writeFile(join(directory, releaseSignatureFile), unverifiedSignature);
  }
  log(
    `fetched ${record.label} (${digest}) into ${directory}, skipping ${skipped.size} image files`,
  );
  return await verifyReleaseBundle(directory, images === "all" ? [] : images, {
    signingPublicKeyPath: input.signingPublicKeyPath,
  });
}
