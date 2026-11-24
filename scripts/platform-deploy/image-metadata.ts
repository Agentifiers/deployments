import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CommandRunner, log, repositoryRoot, singleLine } from "./process.ts";

/**
 * A document an image carries that its deployment consumes. The image's
 * Dockerfile exports it from a `scratch` stage, so the release records the
 * document of the exact image it ships and passes it to OpenTofu.
 */
export interface ImageDeploymentMetadata {
  /** Dockerfile stage whose filesystem root holds `file`. */
  readonly stage: string;
  /** File name the stage exports; the bundle stores it as `images/<image>.<file>`. */
  readonly file: string;
  /** OpenTofu variable that receives the decoded document. */
  readonly terraformVariable: string;
  /** Validates the parsed JSON document and returns it; throws when it is invalid. */
  readonly decode: (document: unknown) => unknown;
}

/** Bundle-relative path of an image's exported document. */
export function imageMetadataFile(image: string, metadata: ImageDeploymentMetadata) {
  return `images/${image}.${metadata.file}`;
}

export function decodeImageMetadata(metadata: ImageDeploymentMetadata, bytes: Uint8Array) {
  try {
    return metadata.decode(JSON.parse(new TextDecoder().decode(bytes)));
  } catch (error) {
    throw new Error(`Invalid ${metadata.file}: ${singleLine(error)}`);
  }
}

/**
 * Exports `metadata.stage` of the image's Dockerfile with the same context and
 * platform as the image build, validates the exported document, and writes it
 * into the bundle. Returns the bundle-relative file.
 */
export async function exportImageMetadata(input: {
  readonly context: string;
  readonly directory: string;
  readonly dockerfile: string;
  readonly metadata: ImageDeploymentMetadata;
  readonly name: string;
  readonly platform: string;
  readonly run: CommandRunner;
}) {
  const { metadata } = input;
  const file = imageMetadataFile(input.name, metadata);
  const output = await mkdtemp(join(tmpdir(), "platform-image-metadata-"));
  try {
    log(`exporting ${metadata.file} from the ${input.name} ${metadata.stage} stage into ${file}`);
    await input.run(
      [
        "docker",
        "buildx",
        "build",
        "--file",
        input.dockerfile,
        "--platform",
        input.platform,
        "--target",
        metadata.stage,
        "--provenance=false",
        "--sbom=false",
        "--output",
        `type=local,dest=${output}`,
        input.context,
      ],
      { cwd: repositoryRoot, prefix: `[${input.name}] `, stream: true },
    );
    let bytes: Uint8Array;
    try {
      bytes = await readFile(join(output, metadata.file));
    } catch {
      throw new Error(
        `The ${metadata.stage} stage of ${input.dockerfile} exported no ${metadata.file}.`,
      );
    }
    decodeImageMetadata(metadata, bytes);
    await writeFile(join(input.directory, file), bytes);
    return file;
  } finally {
    await rm(output, { force: true, recursive: true });
  }
}
