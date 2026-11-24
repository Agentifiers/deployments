import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Schema } from "effect";
import {
  type ConsoleBuild,
  deploymentArtifacts,
  deploymentStaticAssets,
  type DeploymentArtifactName,
  type DeploymentStaticAssetName,
} from "../build-deployment-artifacts.ts";
import { singleLine } from "./process.ts";
import { decodeImageMetadata, imageMetadataFile } from "./image-metadata.ts";
import { type PlatformImage, platformImages, type PlatformImageName } from "./profiles.ts";
import {
  BundleFile,
  decodeReleaseRecord,
  decodeReleaseSignature,
  releaseRecordFile,
  releaseSignatureFile,
  Sha256,
  SourceCommit,
  Timestamp,
} from "./release-registry/record.ts";
import { readSigningPublicKey, verifyReleaseSignature } from "./release-registry/signing.ts";

export const releaseManifestFile = "release.json";
export const buildInfoFile = "build-info.json";

const Artifact = Schema.Struct({ file: BundleFile, sha256: Sha256 });
export const ImageDigest = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^sha256:[0-9a-f]{64}$/u)),
);
const Image = Schema.Struct({
  digest: ImageDigest,
  file: Schema.String.pipe(
    Schema.check(Schema.isPattern(/^images\/[a-z0-9][a-z0-9-]*\.oci\.tar$/u)),
  ),
  /** Document exported from the image's Dockerfile; see `ImageDeploymentMetadata`. */
  metadata: Schema.optionalKey(
    Schema.Struct({
      file: Schema.String.pipe(
        Schema.check(Schema.isPattern(/^images\/[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9.-]*\.json$/u)),
      ),
      sha256: Sha256,
    }),
  ),
  platform: Schema.String,
  sha256: Sha256,
});

const sharedManifestFields = {
  artifacts: Schema.Record(Schema.String, Artifact),
  assets: Schema.Record(Schema.String, Artifact),
  images: Schema.Record(Schema.String, Image),
  sourceCommit: SourceCommit,
};

/** Written before install-supplied console builds, so every version 3 release ships the platform console. */
export const ReleaseManifestV3Document = Schema.Struct({
  ...sharedManifestFields,
  version: Schema.Literal(3),
});

export const ReleaseManifestDocument = Schema.Struct({
  artifacts: sharedManifestFields.artifacts,
  assets: sharedManifestFields.assets,
  /** Present when the console archive and its assets came from an install-supplied build. */
  consoleBuild: Schema.optionalKey(Schema.Literal("install")),
  images: sharedManifestFields.images,
  sourceCommit: sharedManifestFields.sourceCommit,
  version: Schema.Literal(4),
});

const BuildInfoDocument = Schema.Struct({ builtAt: Timestamp, version: Schema.Literal(1) });

export type ReleaseManifest = typeof ReleaseManifestDocument.Type;
export type ReleaseImage = typeof Image.Type;
/** A checksum-verified image archive and, when the image declares one, its decoded metadata. */
export type VerifiedImage = ReleaseImage & {
  readonly deploymentMetadata?: unknown;
  readonly path: string;
};
export type BuildInfo = typeof BuildInfoDocument.Type;

const decodeReleaseManifestV3Document = Schema.decodeUnknownSync(ReleaseManifestV3Document, {
  onExcessProperty: "error",
});
const decodeReleaseManifestDocument = Schema.decodeUnknownSync(ReleaseManifestDocument, {
  onExcessProperty: "error",
});
const decodeBuildInfo = Schema.decodeUnknownSync(BuildInfoDocument, {
  onExcessProperty: "error",
});

export function decodeReleaseManifest(bytes: Uint8Array): ReleaseManifest {
  const document: unknown = JSON.parse(new TextDecoder().decode(bytes));
  const version =
    typeof document === "object" && document !== null && "version" in document
      ? document.version
      : undefined;
  switch (version) {
    case 3:
      return { ...decodeReleaseManifestV3Document(document), version: 4 };
    case 4:
      return decodeReleaseManifestDocument(document);
    default:
      throw new Error(
        `${releaseManifestFile} is version ${JSON.stringify(version) ?? "missing"}; this deploy tool reads versions 3 and 4.`,
      );
  }
}

export function encodeBuildInfo(builtAt: Date) {
  return `${JSON.stringify({ version: 1, builtAt: builtAt.toISOString() })}\n`;
}

export async function readBuildInfo(directory: string): Promise<BuildInfo> {
  try {
    return decodeBuildInfo(JSON.parse(await readFile(join(directory, buildInfoFile), "utf8")));
  } catch (error) {
    throw new Error(`Invalid ${buildInfoFile} in ${directory}: ${singleLine(error)}`);
  }
}

export interface VerifiedRelease {
  readonly artifacts: Readonly<
    Record<DeploymentArtifactName, { readonly path: string; readonly sha256: string }>
  >;
  /** Static asset archives, one per entry of `deploymentStaticAssets`. */
  readonly assets: Readonly<
    Record<DeploymentStaticAssetName, { readonly path: string; readonly sha256: string }>
  >;
  readonly consoleBuild: ConsoleBuild["kind"];
  readonly directory: string;
  readonly images: Readonly<Partial<Record<PlatformImageName, VerifiedImage>>>;
  readonly absentImages: readonly PlatformImageName[];
  /** SHA-256 of release.json, which pins every artifact and image digest of the release. */
  readonly manifestSha256: string;
  readonly sourceCommit: string;
}

export async function sha256File(path: string) {
  const hasher = new Bun.CryptoHasher("sha256");
  for await (const chunk of Bun.file(path).stream()) hasher.update(chunk);
  return hasher.digest("hex");
}

/** Content-bound ECR tag: identical image content from one commit always maps to one tag. */
export function ecrImageTag(sourceCommit: string, digest: string) {
  const hex = /^sha256:([0-9a-f]{64})$/u.exec(digest)?.[1];
  if (!/^[0-9a-f]{40}$/u.test(sourceCommit) || !hex) {
    throw new Error("ECR tags require a 40-hex source commit and a sha256 image digest.");
  }
  return `${sourceCommit}-${hex.slice(0, 12)}`;
}

async function verifiedFile(directory: string, file: string, expected: string) {
  const path = join(directory, file);
  let actual: string;
  try {
    actual = await sha256File(path);
  } catch {
    throw new Error(`Release bundle is missing ${file}.`);
  }
  if (actual !== expected) throw new Error(`Checksum mismatch for ${file}.`);
  return path;
}

function isPlatformImageName(name: string): name is PlatformImageName {
  return Object.hasOwn(platformImages, name);
}

async function verifiedImage(
  directory: string,
  name: PlatformImageName,
  image: ReleaseImage,
): Promise<VerifiedImage> {
  const path = await verifiedFile(directory, image.file, image.sha256);
  const { deploymentMetadata }: PlatformImage = platformImages[name];
  if (!deploymentMetadata) {
    if (image.metadata) {
      throw new Error(
        `Release image ${name} records ${image.metadata.file}, which it does not declare.`,
      );
    }
    return { ...image, path };
  }
  const file = imageMetadataFile(name, deploymentMetadata);
  if (image.metadata?.file !== file) {
    throw new Error(`Release image ${name} must record its ${deploymentMetadata.file} as ${file}.`);
  }
  const metadataPath = await verifiedFile(directory, file, image.metadata.sha256);
  return {
    ...image,
    deploymentMetadata: decodeImageMetadata(deploymentMetadata, await readFile(metadataPath)),
    path,
  };
}

async function optionalBytes(path: string) {
  const file = Bun.file(path);
  return (await file.exists()) ? await file.bytes() : undefined;
}

async function verifyReleaseRecord(
  directory: string,
  manifestSha256: string,
  signingPublicKeyPath: string | undefined,
) {
  const record = await optionalBytes(join(directory, releaseRecordFile));
  if (signingPublicKeyPath !== undefined) {
    if (!record) throw new Error(`Release bundle has no ${releaseRecordFile} to verify.`);
    const signature = await optionalBytes(join(directory, releaseSignatureFile));
    if (!signature) throw new Error(`Release record in ${directory} is unsigned.`);
    const verified = verifyReleaseSignature({
      publicKey: await readSigningPublicKey(signingPublicKeyPath),
      record,
      signature: decodeReleaseSignature(signature),
    });
    if (!verified) {
      throw new Error(`Release record signature does not match ${signingPublicKeyPath}.`);
    }
  }
  if (record && decodeReleaseRecord(record).releaseManifestSha256 !== manifestSha256) {
    throw new Error(`${releaseRecordFile} names a different release than ${releaseManifestFile}.`);
  }
}

export async function verifyReleaseBundle(
  bundle: string,
  requiredImages: readonly PlatformImageName[],
  options: { readonly signingPublicKeyPath?: string | undefined } = {},
): Promise<VerifiedRelease> {
  const directory = resolve(bundle);
  let manifest: ReleaseManifest;
  let manifestSha256: string;
  try {
    const manifestBytes = await readFile(join(directory, releaseManifestFile));
    manifestSha256 = createHash("sha256").update(manifestBytes).digest("hex");
    manifest = decodeReleaseManifest(manifestBytes);
  } catch (error) {
    throw new Error(`Invalid release manifest in ${directory}: ${singleLine(error)}`);
  }
  await verifyReleaseRecord(directory, manifestSha256, options.signingPublicKeyPath);
  const expectedArtifacts = Object.keys(deploymentArtifacts).toSorted();
  if (Object.keys(manifest.artifacts).toSorted().join(",") !== expectedArtifacts.join(",")) {
    throw new Error(`Release bundle must contain exactly ${expectedArtifacts.join(", ")}.`);
  }
  const artifacts = {} as Record<DeploymentArtifactName, { path: string; sha256: string }>;
  for (const name of expectedArtifacts as DeploymentArtifactName[]) {
    const artifact = manifest.artifacts[name]!;
    artifacts[name] = {
      path: await verifiedFile(directory, artifact.file, artifact.sha256),
      sha256: artifact.sha256,
    };
  }
  const expectedAssets = Object.keys(deploymentStaticAssets).toSorted();
  if (Object.keys(manifest.assets).toSorted().join(",") !== expectedAssets.join(",")) {
    throw new Error(`Release bundle must contain exactly the ${expectedAssets.join(", ")} assets.`);
  }
  const assets = {} as Record<DeploymentStaticAssetName, { path: string; sha256: string }>;
  for (const name of expectedAssets as DeploymentStaticAssetName[]) {
    const asset = manifest.assets[name]!;
    assets[name] = {
      path: await verifiedFile(directory, asset.file, asset.sha256),
      sha256: asset.sha256,
    };
  }
  const images: Partial<Record<PlatformImageName, VerifiedImage>> = {};
  const absentImages: PlatformImageName[] = [];
  for (const [name, image] of Object.entries(manifest.images)) {
    if (!isPlatformImageName(name)) throw new Error(`Unknown release image ${name}.`);
    if (!requiredImages.includes(name) && !(await Bun.file(join(directory, image.file)).exists())) {
      absentImages.push(name);
      continue;
    }
    images[name] = await verifiedImage(directory, name, image);
  }
  for (const name of requiredImages) {
    if (!images[name]) throw new Error(`Release bundle is missing the ${name} image archive.`);
  }
  return {
    absentImages,
    artifacts,
    assets,
    consoleBuild: manifest.consoleBuild ?? "platform",
    directory,
    images,
    manifestSha256,
    sourceCommit: manifest.sourceCommit,
  };
}
