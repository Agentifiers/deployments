import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  deploymentArtifacts,
  deploymentStaticAssets,
  staticAssetArchiveName,
  type DeploymentStaticAssetName,
} from "../build-deployment-artifacts.ts";
import { imageMetadataFile } from "./image-metadata.ts";
import { type PlatformImage, platformImages } from "./profiles.ts";

export const fixtureSourceCommit = "0123456789abcdef0123456789abcdef01234567";
export const fixtureImageDigest = `sha256:${"ab".repeat(32)}`;
/** The Firecrawl fork's `dynamodb-table.json`, exported by the fixture firecrawl image. */
export const fixtureFirecrawlTable = readFileSync(
  join(import.meta.dir, "firecrawl-table.fixture.json"),
  "utf8",
);
const fixtureImageMetadata: Readonly<Record<string, string>> = {
  "dynamodb-table.json": fixtureFirecrawlTable,
};

function fixtureImage(directory: string, name: string, salt: string) {
  const image = {
    ...writeBundleFile(directory, `images/${name}.oci.tar`, `image ${name}${salt}`),
    digest: fixtureImageDigest,
    platform: "linux/arm64",
  };
  const definition: PlatformImage | undefined = Object.hasOwn(platformImages, name)
    ? platformImages[name as keyof typeof platformImages]
    : undefined;
  const metadata = definition?.deploymentMetadata;
  if (!metadata) return image;
  const file = imageMetadataFile(name, metadata);
  return {
    ...image,
    metadata: writeBundleFile(directory, file, fixtureImageMetadata[metadata.file]!),
  };
}

function writeBundleFile(directory: string, file: string, content: string) {
  writeFileSync(join(directory, file), content);
  return { file, sha256: createHash("sha256").update(content).digest("hex") };
}

export function writeFixtureBundle(
  directory: string,
  options: {
    readonly builtAt?: string;
    readonly consoleBuild?: "install";
    readonly images?: readonly string[];
    readonly imageSalt?: string;
    readonly sourceCommit?: string;
    readonly version?: 3 | 4;
  } = {},
) {
  const images = options.images ?? ["durable-streams", "observability-hot-plane"];
  const imageSalt = options.imageSalt ?? "";
  mkdirSync(join(directory, "images"), { recursive: true });
  const manifest = {
    artifacts: Object.fromEntries(
      Object.keys(deploymentArtifacts).map((name) => [
        name,
        writeBundleFile(directory, `${name}.zip`, `archive ${name}`),
      ]),
    ),
    assets: Object.fromEntries(
      Object.keys(deploymentStaticAssets).map((name) => [
        name,
        writeBundleFile(
          directory,
          staticAssetArchiveName(name as DeploymentStaticAssetName),
          `assets ${name}`,
        ),
      ]),
    ),
    ...(options.consoleBuild === undefined ? {} : { consoleBuild: options.consoleBuild }),
    images: Object.fromEntries(
      images.map((name) => [name, fixtureImage(directory, name, imageSalt)]),
    ),
    sourceCommit: options.sourceCommit ?? fixtureSourceCommit,
    version: options.version ?? 4,
  };
  writeFileSync(join(directory, "manifest.json"), `{"imageSalt":"${imageSalt}"}\n`);
  writeFileSync(join(directory, "release.json"), JSON.stringify(manifest));
  if (options.builtAt) {
    writeFileSync(
      join(directory, "build-info.json"),
      `${JSON.stringify({ version: 1, builtAt: options.builtAt })}\n`,
    );
  }
  return directory;
}
