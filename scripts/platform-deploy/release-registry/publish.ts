import { createHash, type KeyObject } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { log } from "../process.ts";
import { readBuildInfo, sha256File, verifyReleaseBundle } from "../release-bundle.ts";
import { listPublishedRecords, type PublishedRecord, readPublishedRecord } from "./catalog.ts";
import {
  bundleFilePattern,
  decodeReleaseRecord,
  encodeReleaseRecord,
  encodeReleaseSignature,
  releaseLabel,
  releaseObjectKey,
  releaseRecordFile,
  releaseSignatureFile,
  type CompatibilityReason,
  type ReleaseRecord,
  type ReleaseRecordSignature,
} from "./record.ts";
import {
  readSigningPublicKey,
  type ReleaseSigner,
  signatureStatus,
  verifyReleaseSignature,
} from "./signing.ts";
import { readObjectBytes, type RegistryStore } from "./store.ts";

const expiringTags = { object: "payload", retention: "dev" };
const keptTags = { retention: "dev" };

interface BundleFileEntry {
  readonly file: string;
  readonly path: string;
  readonly sha256: string;
  readonly sizeBytes: number;
}

async function bundleFiles(directory: string): Promise<readonly BundleFileEntry[]> {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  const files: BundleFileEntry[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    const file = relative(directory, path).replaceAll("\\", "/");
    if (file === releaseRecordFile || file === releaseSignatureFile) continue;
    if (!bundleFilePattern.test(file)) {
      throw new Error(`Release bundle contains unexpected file ${file}.`);
    }
    files.push({ file, path, sha256: await sha256File(path), sizeBytes: Bun.file(path).size });
  }
  return files.toSorted((left, right) => left.file.localeCompare(right.file));
}

async function uploadFile(store: RegistryStore, digest: string, entry: BundleFileEntry) {
  const key = releaseObjectKey(digest, entry.file);
  const outcome = await store.putObject({
    body: { kind: "file", path: entry.path, sizeBytes: entry.sizeBytes },
    key,
    sha256: entry.sha256,
    tags: expiringTags,
  });
  if (outcome === "exists" && (await store.headObject(key))?.sha256 !== entry.sha256) {
    throw new Error(`${key} already exists with different content.`);
  }
}

function assertRecordWouldBeWritten(stored: PublishedRecord, record: ReleaseRecord) {
  const expected: ReleaseRecord = {
    ...record,
    ciRunId: stored.record.ciRunId,
    compatibility: stored.record.compatibility,
    deployer: record.deployer ?? stored.record.deployer,
    publishedAt: stored.record.publishedAt,
  };
  if (Buffer.from(stored.bytes).equals(encodeReleaseRecord(expected))) return;
  const storedFields = new Map(Object.entries(stored.record));
  const differing = Object.entries(expected)
    .filter(([field, value]) => !isDeepStrictEqual(value, storedFields.get(field)))
    .map(([field]) => field);
  throw new Error(
    `Release ${record.releaseManifestSha256} already has a record this run would not write; it differs in ${differing.length > 0 ? differing.join(", ") : "its JSON encoding"}.`,
  );
}

interface Signing {
  readonly publicKey: KeyObject;
  readonly signer: ReleaseSigner;
}

async function signRecord(input: Signing & { readonly bytes: Uint8Array }) {
  const { keyId, signature } = await input.signer.sign(input.bytes);
  const document: ReleaseRecordSignature = {
    algorithm: "ECDSA_SHA_256",
    keyId,
    signature: Buffer.from(signature).toString("base64"),
    version: 1,
  };
  if (
    !verifyReleaseSignature({
      publicKey: input.publicKey,
      record: input.bytes,
      signature: document,
    })
  ) {
    throw new Error(`Signing key ${keyId} produced a signature its public key rejects.`);
  }
  return encodeReleaseSignature(document);
}

async function ensureSignature(input: {
  readonly published: PublishedRecord;
  readonly signed: Uint8Array | undefined;
  readonly signing: Signing;
  readonly store: RegistryStore;
}) {
  const { published, signing, store } = input;
  const key = releaseObjectKey(published.record.releaseManifestSha256, releaseSignatureFile);
  let stored = published.unverifiedSignature;
  if (!stored) {
    const bytes = input.signed ?? (await signRecord({ bytes: published.bytes, ...signing }));
    const outcome = await store.putObject({
      body: { bytes, kind: "bytes" },
      key,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      tags: keptTags,
    });
    if (outcome === "created") return;
    stored = await readObjectBytes(store, key);
  }
  const status = signatureStatus({
    publicKey: signing.publicKey,
    record: published.bytes,
    signature: stored,
  });
  if (status !== "verified") {
    throw new Error(`${key} exists but does not verify with the configured signing key.`);
  }
}

async function writeSignedRecord(input: {
  readonly bytes: Uint8Array;
  readonly record: ReleaseRecord;
  readonly signature: Uint8Array | undefined;
  readonly store: RegistryStore;
}): Promise<{ readonly published: PublishedRecord; readonly signed: Uint8Array | undefined }> {
  const { bytes, record, signature, store } = input;
  const digest = record.releaseManifestSha256;
  const outcome = await store.putObject({
    body: { bytes, kind: "bytes" },
    key: releaseObjectKey(digest, releaseRecordFile),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    tags: keptTags,
  });
  if (outcome === "created") {
    return { published: { bytes, record, unverifiedSignature: undefined }, signed: signature };
  }
  const published = await readPublishedRecord(store, digest);
  if (!published) throw new Error(`Release record for ${digest} vanished after a conflict.`);
  return { published, signed: undefined };
}

async function compatibilityOf(input: {
  readonly builtAt: string;
  readonly compatibilityReasons: PublishInput["compatibilityReasons"];
  readonly digest: string;
  readonly publicKey: KeyObject | undefined;
  readonly sourceCommit: string;
  readonly store: RegistryStore;
}): Promise<ReleaseRecord["compatibility"]> {
  const { builtAt, digest, publicKey } = input;
  let newest: ReleaseRecord | undefined;
  for (const { bytes, record, unverifiedSignature } of await listPublishedRecords(input.store)) {
    if (record.releaseManifestSha256 === digest || record.builtAt >= builtAt) continue;
    if (
      publicKey &&
      signatureStatus({ publicKey, record: bytes, signature: unverifiedSignature }) !== "verified"
    ) {
      continue;
    }
    if (!newest || record.builtAt > newest.builtAt) newest = record;
  }
  const reasons = newest
    ? await input.compatibilityReasons(newest.sourceCommit, input.sourceCommit)
    : [];
  return {
    comparedWith: newest?.releaseManifestSha256 ?? null,
    reasons,
    rollbackBarrier: reasons.length > 0,
  };
}

export interface PublishInput {
  readonly bundle: string;
  readonly ciRunId: number | null;
  readonly compatibilityReasons: (
    from: string,
    to: string,
  ) => Promise<readonly CompatibilityReason[]>;
  readonly deployerImage: string | null;
  readonly now: () => Date;
  readonly signer: ReleaseSigner | undefined;
  readonly signingPublicKeyPath: string | undefined;
  readonly store: RegistryStore;
}

export async function publishRelease(input: PublishInput): Promise<ReleaseRecord> {
  const { store } = input;
  const release = await verifyReleaseBundle(input.bundle, []);
  if (release.consoleBuild === "install") {
    throw new Error(
      `Refusing to publish ${release.manifestSha256}: its console is an install-supplied build, and customers install releases from the registry. Publish the platform build of ${release.sourceCommit} instead, built by release build without DEPLOYMENTS_AI_CONSOLE_OUTPUT_DIR.`,
    );
  }
  if (release.absentImages.length > 0) {
    throw new Error(`Refusing to publish without the ${release.absentImages.join(", ")} images.`);
  }
  const { builtAt } = await readBuildInfo(release.directory);
  const digest = release.manifestSha256;
  const files = await bundleFiles(release.directory);
  const signing = input.signer
    ? { publicKey: await input.signer.publicKey(), signer: input.signer }
    : undefined;
  const publicKey =
    signing?.publicKey ??
    (input.signingPublicKeyPath === undefined
      ? undefined
      : await readSigningPublicKey(input.signingPublicKeyPath));

  const existing = await readPublishedRecord(store, digest);
  if (existing) {
    log(`release ${digest} is already published; checking its record`);
  } else {
    for (const entry of files) await uploadFile(store, digest, entry);
    log(`uploaded ${files.length} files to ${releaseObjectKey(digest, "")}`);
  }
  const bytes = encodeReleaseRecord({
    builtAt,
    ciRunId: input.ciRunId,
    compatibility:
      existing?.record.compatibility ??
      (await compatibilityOf({
        builtAt,
        compatibilityReasons: input.compatibilityReasons,
        digest,
        publicKey,
        sourceCommit: release.sourceCommit,
        store,
      })),
    deployer: input.deployerImage === null ? null : { image: input.deployerImage },
    files: Object.fromEntries(
      files.map(({ file, sha256, sizeBytes }) => [file, { sha256, sizeBytes }]),
    ),
    label: releaseLabel(builtAt, release.sourceCommit),
    publishedAt: input.now().toISOString(),
    releaseManifestSha256: digest,
    sizeBytes: files.reduce((total, { sizeBytes }) => total + sizeBytes, 0),
    sourceCommit: release.sourceCommit,
    version: 1,
  });
  const record = decodeReleaseRecord(bytes);
  const { published, signed } = existing
    ? { published: existing, signed: undefined }
    : await writeSignedRecord({
        bytes,
        record,
        signature: signing ? await signRecord({ bytes, ...signing }) : undefined,
        store,
      });
  assertRecordWouldBeWritten(published, record);
  if (signing) await ensureSignature({ published, signed, signing, store });
  return published.record;
}
