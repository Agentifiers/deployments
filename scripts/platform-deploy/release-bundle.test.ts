import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import {
  fixtureFirecrawlTable,
  fixtureImageDigest as digest,
  fixtureSourceCommit as sourceCommit,
  writeFixtureBundle,
} from "./release-bundle.fixture.ts";
import {
  ecrImageTag,
  readBuildInfo,
  ReleaseManifestDocument,
  ReleaseManifestV3Document,
  verifyReleaseBundle,
} from "./release-bundle.ts";

const releaseManifestShapes: Readonly<Record<number, string>> = {
  1: "fd311016f60a272ef09b2c6df11b39f13dc5873fa9be81b23bac2ad1e1bad754",
  2: "e9e8c56fa14d6d0b5b7ce500b84ad346512297d3998c3cf410ea8d83c6a0442a",
  3: "6816b6b416e3dbe4e6b1b1aab39f609831f9fe1f8dde430209587a9628587e70",
  4: "9085d6e89cef5a0ddb91b8d2a0745085581f2831fed13b5ddecb6afb0dd97742",
};

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { force: true, recursive: true });
});

function bundle(options: Parameters<typeof writeFixtureBundle>[1] = {}) {
  const directory = mkdtempSync(join(tmpdir(), "platform-release-"));
  directories.push(directory);
  return writeFixtureBundle(directory, options);
}

describe("release bundle verification", () => {
  test("returns verified artifacts, assets, and images for a complete bundle", async () => {
    const directory = bundle();
    const release = await verifyReleaseBundle(directory, ["durable-streams"]);
    expect(release.sourceCommit).toBe(sourceCommit);
    expect(Object.keys(release.artifacts)).toHaveLength(14);
    expect(release.artifacts["event-analytics-projector"].path).toBe(
      join(directory, "event-analytics-projector.zip"),
    );
    expect(release.artifacts["platform-api"].path).toBe(join(directory, "platform-api.zip"));
    expect(release.artifacts.console.path).toBe(join(directory, "console.zip"));
    expect(release.assets.console.path).toBe(join(directory, "console-assets.zip"));
    expect(release.images["observability-hot-plane"]).toEqual({
      digest,
      file: "images/observability-hot-plane.oci.tar",
      path: join(directory, "images/observability-hot-plane.oci.tar"),
      platform: "linux/arm64",
      sha256: "edb490825bf65dfe0fdefe3fa09c51c2f0879114547f863ab1e72660bdded207",
    });
    expect(release.absentImages).toEqual([]);
    expect(release.consoleBuild).toBe("platform");
  });

  test("reports a console archive that came from an install-supplied build", async () => {
    const release = await verifyReleaseBundle(bundle({ consoleBuild: "install" }), []);
    expect(release.consoleBuild).toBe("install");
  });

  test("rejects a file whose checksum differs from the manifest", async () => {
    const directory = bundle();
    writeFileSync(join(directory, "platform-api.zip"), "tampered");
    expect(verifyReleaseBundle(directory, [])).rejects.toThrow(
      "Checksum mismatch for platform-api.zip.",
    );
    const imageDirectory = bundle();
    writeFileSync(join(imageDirectory, "images/durable-streams.oci.tar"), "tampered");
    expect(verifyReleaseBundle(imageDirectory, [])).rejects.toThrow(
      "Checksum mismatch for images/durable-streams.oci.tar.",
    );
  });

  test("requires an image archive for every profile image", async () => {
    expect(
      verifyReleaseBundle(bundle({ images: ["durable-streams"] }), [
        "durable-streams",
        "web-tools-proxy",
      ]),
    ).rejects.toThrow("missing the web-tools-proxy image archive");
    const directory = bundle({ images: ["durable-streams", "firecrawl"] });
    rmSync(join(directory, "images/durable-streams.oci.tar"));
    expect(verifyReleaseBundle(directory, ["durable-streams"])).rejects.toThrow(
      "Release bundle is missing images/durable-streams.oci.tar.",
    );
  });

  test("leaves out image archives outside the profile and still checks present ones", async () => {
    const directory = bundle({ images: ["durable-streams", "firecrawl", "web-tools-proxy"] });
    rmSync(join(directory, "images/firecrawl.oci.tar"));
    const release = await verifyReleaseBundle(directory, ["durable-streams"]);
    expect(Object.keys(release.images).toSorted()).toEqual(["durable-streams", "web-tools-proxy"]);
    expect(release.absentImages).toEqual(["firecrawl"]);

    writeFileSync(join(directory, "images/web-tools-proxy.oci.tar"), "tampered");
    expect(verifyReleaseBundle(directory, ["durable-streams"])).rejects.toThrow(
      "Checksum mismatch for images/web-tools-proxy.oci.tar.",
    );
  });

  test("rejects an image name the platform does not build", async () => {
    const directory = bundle({ images: ["durable-streams", "mystery"] });
    expect(verifyReleaseBundle(directory, [])).rejects.toThrow("Unknown release image mystery.");
  });

  test("verifies and decodes the deployment metadata an image declares", async () => {
    const directory = bundle({ images: ["durable-streams", "firecrawl"] });
    const release = await verifyReleaseBundle(directory, ["firecrawl"]);
    expect(release.images.firecrawl?.metadata).toEqual({
      file: "images/firecrawl.dynamodb-table.json",
      sha256: createHash("sha256").update(fixtureFirecrawlTable).digest("hex"),
    });
    expect(release.images.firecrawl?.deploymentMetadata).toEqual(JSON.parse(fixtureFirecrawlTable));
    expect(release.images["durable-streams"]).not.toHaveProperty("deploymentMetadata");

    writeFileSync(join(directory, "images/firecrawl.dynamodb-table.json"), "{}");
    expect(verifyReleaseBundle(directory, ["firecrawl"])).rejects.toThrow(
      "Checksum mismatch for images/firecrawl.dynamodb-table.json.",
    );
  });

  test("refuses image metadata that is missing, undeclared, or invalid", async () => {
    type ManifestImages = Record<string, { metadata?: { sha256: string } }>;
    const rewrite = (directory: string, change: (images: ManifestImages) => void) => {
      const manifest = JSON.parse(readFileSync(join(directory, "release.json"), "utf8"));
      change(manifest.images);
      writeFileSync(join(directory, "release.json"), JSON.stringify(manifest));
      return directory;
    };
    const missing = rewrite(bundle({ images: ["firecrawl"] }), (images) => {
      delete images.firecrawl!.metadata;
    });
    expect(verifyReleaseBundle(missing, [])).rejects.toThrow(
      "Release image firecrawl must record its dynamodb-table.json as images/firecrawl.dynamodb-table.json.",
    );
    const undeclared = rewrite(bundle({ images: ["firecrawl", "durable-streams"] }), (images) => {
      images["durable-streams"]!.metadata = images.firecrawl!.metadata!;
    });
    expect(verifyReleaseBundle(undeclared, [])).rejects.toThrow(
      "Release image durable-streams records images/firecrawl.dynamodb-table.json, which it does not declare.",
    );
    const invalidTable = JSON.stringify({ ...JSON.parse(fixtureFirecrawlTable), range_key: "x" });
    const invalid = rewrite(bundle({ images: ["firecrawl"] }), (images) => {
      images.firecrawl!.metadata!.sha256 = createHash("sha256").update(invalidTable).digest("hex");
    });
    writeFileSync(join(invalid, "images/firecrawl.dynamodb-table.json"), invalidTable);
    expect(verifyReleaseBundle(invalid, [])).rejects.toThrow(
      "Invalid dynamodb-table.json: attributes (gsi1pk, gsi1sk, gsi2pk, gsi2sk, gsi3pk, gsi3sk, pk, sk) must declare each table and index key exactly once",
    );
  });

  test("rejects a referenced file that is absent", async () => {
    const directory = bundle();
    rmSync(join(directory, "event-dispatcher.zip"));
    expect(verifyReleaseBundle(directory, [])).rejects.toThrow("missing event-dispatcher.zip");
    const withoutProjector = bundle();
    rmSync(join(withoutProjector, "event-analytics-projector.zip"));
    expect(verifyReleaseBundle(withoutProjector, [])).rejects.toThrow(
      "missing event-analytics-projector.zip",
    );
  });

  test("verifies the console static asset archive", async () => {
    const tampered = bundle();
    writeFileSync(join(tampered, "console-assets.zip"), "tampered");
    expect(verifyReleaseBundle(tampered, [])).rejects.toThrow(
      "Checksum mismatch for console-assets.zip.",
    );
    const missing = bundle();
    const manifest = JSON.parse(readFileSync(join(missing, "release.json"), "utf8"));
    manifest.assets = {};
    writeFileSync(join(missing, "release.json"), JSON.stringify(manifest));
    expect(verifyReleaseBundle(missing, [])).rejects.toThrow(
      "Release bundle must contain exactly the console assets.",
    );
  });

  test("refuses a release record that names another release", async () => {
    const directory = bundle();
    writeFileSync(
      join(directory, "release-record.json"),
      readFileSync(join(import.meta.dir, "release-registry/record.fixture.json")),
    );
    expect(verifyReleaseBundle(directory, [])).rejects.toThrow(
      "release-record.json names a different release than release.json.",
    );
  });
});

function shapeFingerprint(schema: Schema.Top) {
  return createHash("sha256")
    .update(JSON.stringify(Schema.toJsonSchemaDocument(schema)))
    .digest("hex");
}

describe("release.json versions", () => {
  test("verifies a version 3 release as one that ships the platform console", async () => {
    const release = await verifyReleaseBundle(bundle({ version: 3 }), ["durable-streams"]);
    expect({
      absentImages: release.absentImages,
      consoleBuild: release.consoleBuild,
      sourceCommit: release.sourceCommit,
    }).toEqual({ absentImages: [], consoleBuild: "platform", sourceCommit });
  });

  test("refuses a version 3 manifest that names a console build", async () => {
    const directory = bundle({ consoleBuild: "install", version: 3 });
    expect(await verifyReleaseBundle(directory, []).then(() => "verified", String)).toBe(
      `Error: Invalid release manifest in ${directory}: Unexpected key with value "install" at ["consoleBuild"]`,
    );
  });

  test("names the version of a manifest this tool does not read", async () => {
    const directory = bundle();
    const manifest = JSON.parse(readFileSync(join(directory, "release.json"), "utf8"));
    manifest.version = 2;
    writeFileSync(join(directory, "release.json"), JSON.stringify(manifest));
    expect(await verifyReleaseBundle(directory, []).then(() => "verified", String)).toBe(
      `Error: Invalid release manifest in ${directory}: release.json is version 2; this deploy tool reads versions 3 and 4.`,
    );
  });

  test("reads version 3 in exactly the shape version 3 had", () => {
    expect(shapeFingerprint(ReleaseManifestV3Document)).toBe(releaseManifestShapes[3]!);
  });

  test("keeps one shape per version: to change the shape, bump the version and record its fingerprint", () => {
    const version: number = ReleaseManifestDocument.fields.version.literal;
    const observed: { readonly shape: string | undefined; readonly version: number } = {
      shape: shapeFingerprint(ReleaseManifestDocument),
      version,
    };
    expect(observed).toEqual({
      shape: releaseManifestShapes[version],
      version: Math.max(...Object.keys(releaseManifestShapes).map(Number)),
    });
  });
});

describe("build info", () => {
  test("reads the build time release build records beside release.json", async () => {
    const directory = bundle({ builtAt: "2026-10-09T03:51:43.000Z" });
    expect(await readBuildInfo(directory)).toEqual({
      builtAt: "2026-10-09T03:51:43.000Z",
      version: 1,
    });
    writeFileSync(join(directory, "build-info.json"), '{"version":1,"builtAt":"yesterday"}');
    expect(readBuildInfo(directory)).rejects.toThrow("Invalid build-info.json");
  });
});

describe("ECR image tags", () => {
  test("binds the tag to both the commit and the image content", () => {
    expect(ecrImageTag(sourceCommit, digest)).toBe(`${sourceCommit}-abababababab`);
    expect(ecrImageTag(sourceCommit, `sha256:${"cd".repeat(32)}`)).toBe(
      `${sourceCommit}-cdcdcdcdcdcd`,
    );
  });

  test("rejects abbreviated commits and non-digest image references", () => {
    expect(() => ecrImageTag("0123456", digest)).toThrow("40-hex");
    expect(() => ecrImageTag(sourceCommit, "deployments-ai/durable-streams")).toThrow("40-hex");
  });
});
