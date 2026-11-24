import { mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { Schema } from "effect";
import { buildDeploymentArtifacts, type ConsoleBuild } from "../build-deployment-artifacts.ts";
import { type CommandRunner, log, repositoryRoot, singleLine } from "./process.ts";
import { exportImageMetadata } from "./image-metadata.ts";
import {
  type PlatformImage,
  platformImageNames,
  platformImages,
  type PlatformImageName,
} from "./profiles.ts";
import {
  buildInfoFile,
  encodeBuildInfo,
  ImageDigest,
  releaseManifestFile,
  sha256File,
  type ReleaseImage,
  type ReleaseManifest,
} from "./release-bundle.ts";

const OciLayoutIndex = Schema.Struct({
  manifests: Schema.Tuple([
    Schema.Struct({
      digest: ImageDigest,
      mediaType: Schema.Literal("application/vnd.oci.image.index.v1+json"),
    }),
  ]),
});
const decodeOciLayoutIndex = Schema.decodeUnknownSync(OciLayoutIndex);

async function assertReplaceableBundle(directory: string) {
  const fromBundleToRepository = relative(directory, repositoryRoot);
  if (!fromBundleToRepository.startsWith("..")) {
    throw new Error(`Refusing to replace ${directory}; it contains the repository.`);
  }
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch {
    return;
  }
  if (
    entries.length > 0 &&
    !entries.includes(releaseManifestFile) &&
    !entries.includes("manifest.json")
  ) {
    throw new Error(
      `Refusing to replace ${directory}; it is not empty and is not a release bundle.`,
    );
  }
}

/**
 * Builds one platform image into an OCI image layout archive. The archive holds
 * the image index, whose attestation manifest carries the SLSA provenance and
 * the SPDX SBOM, so publishing it by digest keeps both. An image that declares
 * deployment metadata also exports it from the same Dockerfile and context.
 */
export async function buildReleaseImage(input: {
  readonly directory: string;
  readonly name: PlatformImageName;
  readonly run: CommandRunner;
}): Promise<ReleaseImage> {
  const definition: PlatformImage = platformImages[input.name];
  const file = `images/${input.name}.oci.tar`;
  const path = join(input.directory, file);
  log(`building ${input.name} image (${definition.platform}) into ${file}`);
  await input.run(
    [
      "docker",
      "buildx",
      "build",
      "--file",
      definition.dockerfile,
      "--platform",
      definition.platform,
      "--provenance=mode=max",
      "--sbom=true",
      "--output",
      `type=oci,dest=${path}`,
      definition.context,
    ],
    { cwd: repositoryRoot, prefix: `[${input.name}] `, stream: true },
  );
  let digest: string;
  try {
    const index = await input.run(["tar", "-xOf", path, "index.json"]);
    [{ digest }] = decodeOciLayoutIndex(JSON.parse(index)).manifests;
  } catch (error) {
    throw new Error(`${file} does not hold exactly one OCI image index: ${singleLine(error)}`);
  }
  const image: ReleaseImage = {
    digest,
    file,
    platform: definition.platform,
    sha256: await sha256File(path),
  };
  if (!definition.deploymentMetadata) return image;
  const metadataFile = await exportImageMetadata({
    context: definition.context,
    directory: input.directory,
    dockerfile: definition.dockerfile,
    metadata: definition.deploymentMetadata,
    name: input.name,
    platform: definition.platform,
    run: input.run,
  });
  return {
    ...image,
    metadata: { file: metadataFile, sha256: await sha256File(join(input.directory, metadataFile)) },
  };
}

export function releaseManifest(input: {
  readonly artifacts: ReleaseManifest["artifacts"];
  readonly assets: ReleaseManifest["assets"];
  readonly consoleBuild: ConsoleBuild;
  readonly images: ReleaseManifest["images"];
  readonly sourceCommit: string;
}): ReleaseManifest {
  const { artifacts, assets, consoleBuild, images, sourceCommit } = input;
  return {
    artifacts,
    assets,
    ...(consoleBuild.kind === "install" ? { consoleBuild: "install" } : {}),
    images,
    sourceCommit,
    version: 4,
  };
}

async function writeBundleFiles(input: {
  readonly consoleBuild: ConsoleBuild;
  readonly directory: string;
  readonly run: CommandRunner;
  readonly sourceCommit: string;
}): Promise<ReleaseManifest> {
  const { consoleBuild, directory, run, sourceCommit } = input;
  log(`building Lambda artifacts into ${directory}`);
  if (consoleBuild.kind === "install") {
    log(
      `packaging the install-supplied console build from ${dirname(consoleBuild.serverDirectory)}`,
    );
  }
  // The images and the Lambda artifacts are independent builds, so they run concurrently and the
  // slowest one, not their sum, bounds the release. The artifact build starts by replacing
  // `directory`, so the images build into a sibling and move in once both are done.
  const imageDirectory = `${directory}.images`;
  await rm(imageDirectory, { force: true, recursive: true });
  await mkdir(join(imageDirectory, "images"), { recursive: true });
  const [{ artifacts, assets }, imageBuilds] = await Promise.all([
    buildDeploymentArtifacts({ consoleBuild, directory }),
    Promise.allSettled(
      platformImageNames.map(
        async (name) =>
          [name, await buildReleaseImage({ directory: imageDirectory, name, run })] as const,
      ),
    ),
  ]);
  const failedImage = imageBuilds.find((build) => build.status === "rejected");
  if (failedImage) throw failedImage.reason;
  const images = Object.fromEntries(
    imageBuilds.flatMap((build) => (build.status === "fulfilled" ? [build.value] : [])),
  );
  await rename(join(imageDirectory, "images"), join(directory, "images"));
  await rm(imageDirectory, { recursive: true });
  await writeFile(join(directory, buildInfoFile), encodeBuildInfo(new Date()));
  return releaseManifest({ artifacts, assets, consoleBuild, images, sourceCommit });
}

/**
 * Builds the release bundle from the checked-out commit: deterministic Lambda
 * archives, static asset archives, every platform image as an OCI layout
 * archive, and `release.json`. An install-supplied console build replaces the
 * console archive and its static assets.
 */
export async function buildRelease(input: {
  readonly bundle: string;
  readonly consoleBuild: ConsoleBuild;
  readonly run: CommandRunner;
}) {
  const sourceCommit = (
    await input.run(["git", "rev-parse", "HEAD"], { cwd: repositoryRoot })
  ).trim();
  if (!/^[0-9a-f]{40}$/u.test(sourceCommit)) {
    throw new Error("Unable to resolve an immutable 40-hex release commit.");
  }
  const directory = resolve(input.bundle);
  await assertReplaceableBundle(directory);
  const manifest = await writeBundleFiles({
    consoleBuild: input.consoleBuild,
    directory,
    run: input.run,
    sourceCommit,
  });
  await writeFile(join(directory, releaseManifestFile), `${JSON.stringify(manifest, null, 2)}\n`);
  log(`release ${sourceCommit} written to ${directory}`);
  return manifest;
}
