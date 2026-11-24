import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  bundledThirdPartyComponents,
  readThirdPartyComponent,
  renderClientPackageNotice,
} from "./client-package-notice.ts";

const root = resolve(import.meta.dir, "..");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

async function fixturePackage(
  directory: string,
  manifest: Record<string, string>,
  files: Record<string, string>,
) {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "package.json"), JSON.stringify(manifest), "utf8");
  for (const [name, contents] of Object.entries(files)) {
    await writeFile(join(directory, name), contents, "utf8");
  }
}

async function fixtureRoot() {
  const directory = await mkdtemp(join(tmpdir(), "client-package-notice-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("client package notices", () => {
  test("reproduces the license of each third-party package that contributes bundled bytes", async () => {
    const fixture = await fixtureRoot();
    await fixturePackage(
      join(fixture, "node_modules/.bun/left@1.0.0/node_modules/left"),
      { name: "left", version: "1.0.0", license: "MIT" },
      { LICENSE: "MIT License\n\nCopyright (c) Left\n" },
    );
    await fixturePackage(
      join(fixture, "node_modules/@scope/right"),
      { name: "@scope/right", version: "2.0.0", license: "ISC" },
      { "LICENSE-MIT.txt": "Copyright Right\n" },
    );
    await fixturePackage(
      join(fixture, "node_modules/unused"),
      { name: "unused", version: "3.0.0", license: "MIT" },
      { LICENSE: "unused\n" },
    );

    const components = await bundledThirdPartyComponents({
      root: fixture,
      metafile: {
        outputs: {
          "./bin.js": {
            inputs: {
              "node_modules/@scope/right/dist/index.js": { bytesInOutput: 10 },
              "node_modules/.bun/left@1.0.0/node_modules/left/a.js": { bytesInOutput: 5 },
              "node_modules/.bun/left@1.0.0/node_modules/left/b.js": { bytesInOutput: 7 },
              "node_modules/unused/index.js": { bytesInOutput: 0 },
              "packages/cli/src/bin.ts": { bytesInOutput: 20 },
            },
          },
        },
      },
    });

    expect(components).toEqual([
      { name: "@scope/right", version: "2.0.0", license: "ISC", licenseText: "Copyright Right" },
      {
        name: "left",
        version: "1.0.0",
        license: "MIT",
        licenseText: "MIT License\n\nCopyright (c) Left",
      },
    ]);
  });

  test("fails closed when a bundled package ships no license file", async () => {
    const fixture = await fixtureRoot();
    await fixturePackage(
      join(fixture, "node_modules/bare"),
      { name: "bare", version: "1.0.0", license: "MIT" },
      {},
    );

    expect(readThirdPartyComponent(join(fixture, "node_modules/bare"))).rejects.toThrow(
      "ships no license file",
    );
  });

  test("appends third-party licenses after the package notice", () => {
    const notice = renderClientPackageNotice({
      packageNotice: "@agentifiers/deployments-cli\nMIT\n\n",
      components: [
        { name: "left", version: "1.0.0", license: "MIT", licenseText: "Copyright (c) Left" },
      ],
    });

    expect(notice.startsWith("@agentifiers/deployments-cli\nMIT\n\nThis package includes")).toBe(
      true,
    );
    expect(notice).toContain("left 1.0.0 (MIT)");
    expect(notice.endsWith("Copyright (c) Left\n")).toBe(true);
    expect(renderClientPackageNotice({ packageNotice: "only\n\n", components: [] })).toBe("only\n");
  });

  test("ships each client package's own MIT license and notice", async () => {
    for (const directory of ["packages/sdk", "packages/cli"]) {
      const license = await readFile(resolve(root, directory, "LICENSE"), "utf8");
      const notice = await readFile(resolve(root, directory, "NOTICE"), "utf8");
      const manifest = (await Bun.file(resolve(root, directory, "package.json")).json()) as {
        license?: string;
      };

      expect(license.startsWith("MIT License\n\nCopyright (c) 2026 Cinematic Software LLC")).toBe(
        true,
      );
      expect(notice).toContain("licensed under the MIT License");
      expect(manifest.license).toBe("MIT");
    }
  });
});
