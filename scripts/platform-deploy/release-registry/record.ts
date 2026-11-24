import { Schema } from "effect";

export const releaseRecordFile = "release-record.json";
export const releaseSignatureFile = "release-record.sig.json";

export const Sha256 = Schema.String.pipe(Schema.check(Schema.isPattern(/^[0-9a-f]{64}$/u)));
export const SourceCommit = Schema.String.pipe(Schema.check(Schema.isPattern(/^[0-9a-f]{40}$/u)));
export const Timestamp = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u)),
);
export const bundleFilePattern = /^(?:images\/)?[a-z0-9][a-z0-9.-]*$/u;
export const BundleFile = Schema.String.pipe(Schema.check(Schema.isPattern(bundleFilePattern)));
const ByteCount = Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)));
const RepositoryPath = Schema.String.pipe(Schema.check(Schema.isPattern(/^[^/\s][^\s]*$/u)));

export const CompatibilityReason = Schema.Union([
  Schema.Struct({
    count: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(1))),
    file: RepositoryPath,
    kind: Schema.Literal("terraform-moved"),
  }),
  Schema.Struct({ file: RepositoryPath, kind: Schema.Literal("record-schema") }),
  Schema.Struct({ kind: Schema.Literal("deploy-migration"), name: Schema.NonEmptyString }),
]);

export const ReleaseRecord = Schema.Struct({
  builtAt: Timestamp,
  ciRunId: Schema.NullOr(Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(1)))),
  compatibility: Schema.Struct({
    comparedWith: Schema.NullOr(Sha256),
    reasons: Schema.Array(CompatibilityReason),
    rollbackBarrier: Schema.Boolean,
  }).pipe(
    Schema.check(
      Schema.makeFilter((compatibility) =>
        compatibility.rollbackBarrier === compatibility.reasons.length > 0
          ? undefined
          : "rollbackBarrier must be true exactly when reasons is non-empty.",
      ),
    ),
  ),
  deployer: Schema.NullOr(
    Schema.Struct({
      image: Schema.String.pipe(Schema.check(Schema.isPattern(/^[^@\s]+@sha256:[0-9a-f]{64}$/u))),
    }),
  ),
  files: Schema.Record(Schema.String, Schema.Struct({ sha256: Sha256, sizeBytes: ByteCount })).pipe(
    Schema.check(
      // A refined key schema would silently drop a non-matching key instead of failing.
      Schema.makeFilter((files) => {
        const outside = Object.keys(files).filter((file) => !bundleFilePattern.test(file));
        return outside.length === 0
          ? undefined
          : `files lists paths outside a bundle: ${outside.join(", ")}`;
      }),
    ),
  ),
  label: Schema.String.pipe(Schema.check(Schema.isPattern(/^\d{4}\.\d{2}\.\d{2}-[0-9a-f]{7}$/u))),
  publishedAt: Timestamp,
  releaseManifestSha256: Sha256,
  sizeBytes: ByteCount,
  sourceCommit: SourceCommit,
  version: Schema.Literal(1),
});

export const ReleaseRecordSignature = Schema.Struct({
  algorithm: Schema.Literal("ECDSA_SHA_256"),
  keyId: Schema.NonEmptyString,
  signature: Schema.String.pipe(Schema.check(Schema.isPattern(/^[A-Za-z0-9+/]+={0,2}$/u))),
  version: Schema.Literal(1),
});

export type CompatibilityReason = typeof CompatibilityReason.Type;
export type ReleaseRecord = typeof ReleaseRecord.Type;
export type ReleaseRecordSignature = typeof ReleaseRecordSignature.Type;

const decodeRecordDocument = Schema.decodeUnknownSync(ReleaseRecord, {
  onExcessProperty: "error",
});
const decodeSignatureDocument = Schema.decodeUnknownSync(ReleaseRecordSignature, {
  onExcessProperty: "error",
});

export function decodeReleaseRecord(bytes: Uint8Array): ReleaseRecord {
  return decodeRecordDocument(JSON.parse(new TextDecoder().decode(bytes)));
}

export function decodeReleaseSignature(bytes: Uint8Array): ReleaseRecordSignature {
  return decodeSignatureDocument(JSON.parse(new TextDecoder().decode(bytes)));
}

export function encodeReleaseRecord(record: ReleaseRecord) {
  const ordered = {
    version: record.version,
    releaseManifestSha256: record.releaseManifestSha256,
    sourceCommit: record.sourceCommit,
    label: record.label,
    builtAt: record.builtAt,
    publishedAt: record.publishedAt,
    ciRunId: record.ciRunId,
    sizeBytes: record.sizeBytes,
    files: record.files,
    compatibility: {
      comparedWith: record.compatibility.comparedWith,
      rollbackBarrier: record.compatibility.rollbackBarrier,
      reasons: record.compatibility.reasons,
    },
    deployer: record.deployer,
  };
  return new TextEncoder().encode(`${JSON.stringify(ordered, null, 2)}\n`);
}

export function encodeReleaseSignature(signature: ReleaseRecordSignature) {
  const ordered = {
    version: signature.version,
    keyId: signature.keyId,
    algorithm: signature.algorithm,
    signature: signature.signature,
  };
  return new TextEncoder().encode(`${JSON.stringify(ordered)}\n`);
}

export function releaseLabel(builtAt: string, sourceCommit: string) {
  return `${builtAt.slice(0, 10).replaceAll("-", ".")}-${sourceCommit.slice(0, 7)}`;
}

export const releasesPrefix = "releases/";

export function releaseObjectKey(releaseManifestSha256: string, file: string) {
  return `${releasesPrefix}${releaseManifestSha256}/${file}`;
}
