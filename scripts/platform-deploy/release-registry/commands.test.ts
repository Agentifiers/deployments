import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RegistryCommand } from "../cli.ts";
import { registryRegion, runRegistryCommand } from "./commands.ts";

const digest = "ab".repeat(32);
const bucket = "releases";

const bucketCommands: readonly RegistryCommand[] = [
  { bundle: "out", bucket, ciRunId: null, deployerImage: null, kind: "release-publish" },
  { bucket, bundle: "out", kind: "release-fetch", profile: undefined, release: digest },
  { bucket, kind: "release-retain", release: digest },
  { kind: "release-verify", source: { bucket, kind: "registry", release: digest } },
  { bucket, from: digest, kind: "release-rollback-check", to: digest },
];

function sharedFiles(files: { readonly config?: string; readonly credentials?: string }) {
  const directory = mkdtempSync(join(tmpdir(), "registry-region-"));
  const paths = {
    AWS_CONFIG_FILE: join(directory, "config"),
    AWS_SHARED_CREDENTIALS_FILE: join(directory, "credentials"),
  };
  if (files.config !== undefined) writeFileSync(paths.AWS_CONFIG_FILE, files.config);
  if (files.credentials !== undefined) {
    writeFileSync(paths.AWS_SHARED_CREDENTIALS_FILE, files.credentials);
  }
  return paths;
}

const profiles = sharedFiles({
  config: "[default]\nregion = eu-west-1\n\n[profile ops]\nregion = eu-central-1\n",
});

describe("registryRegion", () => {
  test("prefers AWS_REGION, then AWS_DEFAULT_REGION, over the profile", async () => {
    expect(
      await registryRegion({
        ...profiles,
        AWS_DEFAULT_REGION: "ap-south-1",
        AWS_REGION: "us-west-1",
      }),
    ).toBe("us-west-1");
    expect(await registryRegion({ ...profiles, AWS_DEFAULT_REGION: "ap-south-1" })).toBe(
      "ap-south-1",
    );
  });

  test("falls through a blank AWS_REGION to AWS_DEFAULT_REGION", async () => {
    expect(
      await registryRegion({ ...profiles, AWS_DEFAULT_REGION: "us-east-2", AWS_REGION: " " }),
    ).toBe("us-east-2");
  });

  test("reads the region of the profile AWS_PROFILE selects, or of default", async () => {
    expect(await registryRegion(profiles)).toBe("eu-west-1");
    expect(await registryRegion({ ...profiles, AWS_PROFILE: "ops" })).toBe("eu-central-1");
  });

  test("prefers the credentials file's region over the config file's", async () => {
    const files = sharedFiles({
      config: "[default]\nregion = eu-west-1\n",
      credentials: "[default]\nregion = us-east-2\n",
    });
    expect(await registryRegion(files)).toBe("us-east-2");
  });
});

describe("release registry commands", () => {
  const noRegion = sharedFiles({ config: "[default]\noutput = json\n" });

  test.each(bucketCommands.map((command) => [command.kind, command] as const))(
    "%s refuses to run without a region from the environment or the profile",
    (_kind, command) => {
      expect(runRegistryCommand(command, noRegion)).rejects.toThrow("AWS_REGION");
      expect(runRegistryCommand(command, { ...noRegion, AWS_REGION: " " })).rejects.toThrow(
        "AWS_REGION",
      );
    },
  );
});
