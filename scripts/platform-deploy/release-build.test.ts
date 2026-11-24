import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { platformConsoleBuild } from "../build-deployment-artifacts.ts";
import { type CommandRunner, repositoryRoot, runCommand } from "./process.ts";
import { fixtureFirecrawlTable, fixtureSourceCommit } from "./release-bundle.fixture.ts";
import { buildReleaseImage, releaseManifest } from "./release-build.ts";

const indexDigest = `sha256:${"cd".repeat(32)}`;
const imageIndex = {
  manifests: [{ digest: indexDigest, mediaType: "application/vnd.oci.image.index.v1+json" }],
  schemaVersion: 2,
};

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { force: true, recursive: true });
});

function temporaryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "platform-release-build-"));
  directories.push(directory);
  return directory;
}

/** Fake buildx: OCI outputs get a layout holding `index`; local outputs get `exported` files. */
function buildx(index: unknown, exported: Readonly<Record<string, string>> = {}) {
  const builds: { readonly command: readonly string[]; readonly cwd: string | undefined }[] = [];
  const run: CommandRunner = async (command, options = {}) => {
    if (command[0] === "tar") return await runCommand(command);
    builds.push({ command, cwd: options.cwd });
    const output = command[command.indexOf("--output") + 1] ?? "";
    const local = /^type=local,dest=(.+)$/u.exec(output)?.[1];
    if (local) {
      for (const [file, content] of Object.entries(exported)) {
        writeFileSync(join(local, file), content);
      }
      return "";
    }
    const dest = /^type=oci,dest=(.+)$/u.exec(output)?.[1];
    if (!dest) throw new Error(`unexpected command ${command.join(" ")}`);
    const layout = temporaryDirectory();
    writeFileSync(join(layout, "index.json"), JSON.stringify(index));
    mkdirSync(dirname(dest), { recursive: true });
    await runCommand(["tar", "-cf", dest, "-C", layout, "index.json"]);
    return "";
  };
  return { builds, run };
}

describe("release image build", () => {
  test("builds an OCI archive with provenance and an SBOM and records its index digest", async () => {
    const directory = temporaryDirectory();
    const { builds, run } = buildx(imageIndex);
    const image = await buildReleaseImage({ directory, name: "model-gateway", run });
    expect(builds).toEqual([
      {
        command: [
          "docker",
          "buildx",
          "build",
          "--file",
          "apps/model-gateway/Dockerfile",
          "--platform",
          "linux/arm64",
          "--provenance=mode=max",
          "--sbom=true",
          "--output",
          `type=oci,dest=${join(directory, "images/model-gateway.oci.tar")}`,
          ".",
        ],
        cwd: repositoryRoot,
      },
    ]);
    const archive = join(directory, "images/model-gateway.oci.tar");
    expect(image).toEqual({
      digest: indexDigest,
      file: "images/model-gateway.oci.tar",
      platform: "linux/arm64",
      sha256: createHash("sha256").update(readFileSync(archive)).digest("hex"),
    });
  });

  test("refuses an archive whose layout does not hold exactly one image index", async () => {
    const { run } = buildx({
      manifests: [
        {
          digest: indexDigest,
          mediaType: "application/vnd.oci.image.manifest.v1+json",
        },
      ],
      schemaVersion: 2,
    });
    expect(
      buildReleaseImage({ directory: temporaryDirectory(), name: "model-gateway", run }),
    ).rejects.toThrow("images/model-gateway.oci.tar does not hold exactly one OCI image index");
  });

  test("exports an image's declared metadata from the same Dockerfile and records it", async () => {
    const directory = temporaryDirectory();
    const { builds, run } = buildx(imageIndex, { "dynamodb-table.json": fixtureFirecrawlTable });
    const image = await buildReleaseImage({ directory, name: "firecrawl", run });
    const exported = builds[1]?.command ?? [];
    expect(builds.map((build) => build.cwd)).toEqual([repositoryRoot, repositoryRoot]);
    expect(builds[0]?.command).toContain("--provenance=mode=max");
    expect(exported.slice(0, -2)).toEqual([
      "docker",
      "buildx",
      "build",
      "--file",
      "infrastructure/images/firecrawl/Dockerfile",
      "--platform",
      "linux/arm64",
      "--target",
      "dynamodb-table",
      "--provenance=false",
      "--sbom=false",
      "--output",
    ]);
    expect(exported.at(-1)).toBe("infrastructure/images/firecrawl");
    expect(readFileSync(join(directory, "images/firecrawl.dynamodb-table.json"), "utf8")).toBe(
      fixtureFirecrawlTable,
    );
    expect(image.metadata).toEqual({
      file: "images/firecrawl.dynamodb-table.json",
      sha256: createHash("sha256").update(fixtureFirecrawlTable).digest("hex"),
    });
  });

  test("refuses a missing or invalid exported table definition", async () => {
    expect(
      buildReleaseImage({
        directory: temporaryDirectory(),
        name: "firecrawl",
        run: buildx(imageIndex).run,
      }),
    ).rejects.toThrow(
      "The dynamodb-table stage of infrastructure/images/firecrawl/Dockerfile exported no dynamodb-table.json.",
    );
    const unknownVersion = JSON.stringify({ ...JSON.parse(fixtureFirecrawlTable), version: 2 });
    expect(
      buildReleaseImage({
        directory: temporaryDirectory(),
        name: "firecrawl",
        run: buildx(imageIndex, { "dynamodb-table.json": unknownVersion }).run,
      }),
    ).rejects.toThrow("Invalid dynamodb-table.json");
  });
});

describe("release manifest", () => {
  const archive = { file: "console.zip", sha256: "ab".repeat(32) };
  const assets = { console: { file: "console-assets.zip", sha256: "cd".repeat(32) } };
  const contents = {
    artifacts: { console: archive },
    assets,
    images: {},
    sourceCommit: fixtureSourceCommit,
  };

  test("names no console build when the release ships the platform console", () => {
    const manifest = releaseManifest({ ...contents, consoleBuild: platformConsoleBuild });
    expect(Object.keys(manifest)).toEqual([
      "artifacts",
      "assets",
      "images",
      "sourceCommit",
      "version",
    ]);
    expect(manifest).toStrictEqual({
      artifacts: { console: archive },
      assets,
      images: {},
      sourceCommit: fixtureSourceCommit,
      version: 4,
    });
  });

  test("records that the console archive came from an install-supplied build", () => {
    const consoleBuild = {
      kind: "install",
      publicDirectory: "/builds/console/.output/public",
      serverDirectory: "/builds/console/.output/server",
    } as const;
    expect(releaseManifest({ ...contents, consoleBuild })).toEqual({
      artifacts: { console: archive },
      assets,
      consoleBuild: "install",
      images: {},
      sourceCommit: fixtureSourceCommit,
      version: 4,
    });
  });
});
