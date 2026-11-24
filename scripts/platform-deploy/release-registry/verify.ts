import { createHash } from "node:crypto";
import { releaseManifestFile } from "../release-bundle.ts";
import { expiryReason, type PublishedRecord, readPublishedRecord } from "./catalog.ts";
import { releaseObjectKey } from "./record.ts";
import { readSigningPublicKey, type SignatureStatus, signatureStatus } from "./signing.ts";
import { readObjectBytes, type RegistryStore } from "./store.ts";

export function untrustedReason(status: SignatureStatus, signingPublicKeyPath: string) {
  switch (status) {
    case "invalid":
      return `signature does not match ${signingPublicKeyPath}`;
    case "unsigned":
      return "is unsigned";
    case "verified":
      return undefined;
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

export async function readTrustedRecord(input: {
  readonly releaseManifestSha256: string;
  readonly signingPublicKeyPath: string | undefined;
  readonly store: RegistryStore;
}): Promise<PublishedRecord> {
  const { releaseManifestSha256: digest, signingPublicKeyPath, store } = input;
  const published = await readPublishedRecord(store, digest);
  if (!published) throw new Error(`Release ${digest} is not published.`);
  if (signingPublicKeyPath !== undefined) {
    const status = signatureStatus({
      publicKey: await readSigningPublicKey(signingPublicKeyPath),
      record: published.bytes,
      signature: published.unverifiedSignature,
    });
    const reason = untrustedReason(status, signingPublicKeyPath);
    if (reason) throw new Error(`Release ${digest} ${reason}.`);
  }
  return published;
}

export async function verifyPublishedRelease(input: {
  readonly releaseManifestSha256: string;
  readonly signingPublicKeyPath: string | undefined;
  readonly store: RegistryStore;
}) {
  const { releaseManifestSha256: digest, store } = input;
  const { record } = await readTrustedRecord(input);
  const expiry = await expiryReason(store, record);
  if (expiry) throw new Error(`Release ${record.label} (${digest}) ${expiry}.`);
  const manifest = await readObjectBytes(store, releaseObjectKey(digest, releaseManifestFile));
  if (!manifest || createHash("sha256").update(manifest).digest("hex") !== digest) {
    throw new Error(`Release ${digest} has no release.json with that digest.`);
  }
  for (const [file, expected] of Object.entries(record.files)) {
    const stored = await store.headObject(releaseObjectKey(digest, file));
    if (!stored) throw new Error(`Release ${digest} is missing ${file}; it may have expired.`);
    if (stored.sha256 !== expected.sha256 || stored.sizeBytes !== expected.sizeBytes) {
      throw new Error(`Release ${digest} stores ${file} with a different checksum.`);
    }
  }
  return record;
}
