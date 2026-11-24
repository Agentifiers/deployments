import { chmod, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { clientPackageFingerprint } from "./client-package-fingerprint.ts";
import {
  clientPackageLegalFiles,
  clientPackageMetadata,
  writeClientPackageLegalFiles,
} from "./client-package-metadata.ts";
import { bundledThirdPartyComponents } from "./client-package-notice.ts";

const root = resolve(import.meta.dir, "..");
const cliDirectory = resolve(root, "packages/cli");
const packageDirectory = resolve(cliDirectory, "dist/package");
const metafilePath = resolve(cliDirectory, "dist/metafile.json");
const cliPackage = JSON.parse(await readFile(resolve(cliDirectory, "package.json"), "utf8")) as {
  version: string;
};

await rm(resolve(cliDirectory, "dist"), { force: true, recursive: true });
await mkdir(packageDirectory, { recursive: true });

const build = Bun.spawn(
  [
    process.execPath,
    "build",
    resolve(cliDirectory, "src/bin.ts"),
    "--target=bun",
    "--format=esm",
    "--minify",
    `--outdir=${packageDirectory}`,
    "--entry-naming=bin.js",
    `--metafile=${metafilePath}`,
  ],
  { cwd: root, stderr: "inherit", stdout: "inherit" },
);
const exitCode = await build.exited;
if (exitCode !== 0) throw new Error(`CLI build exited with ${exitCode}`);

await chmod(resolve(packageDirectory, "bin.js"), 0o755);
await copyFile(resolve(cliDirectory, "README.md"), resolve(packageDirectory, "README.md"));
await writeClientPackageLegalFiles({
  sourceDirectory: cliDirectory,
  packageDirectory,
  components: await bundledThirdPartyComponents({
    root,
    metafile: JSON.parse(await readFile(metafilePath, "utf8")),
  }),
});
const packageManifest = {
  name: "@agentifiers/deployments-cli",
  version: cliPackage.version,
  description: "Command-line interface for the Deployments.ai public API.",
  type: "module",
  bin: { deployments: "bin.js" },
  files: ["bin.js", ...clientPackageLegalFiles],
  engines: { bun: ">=1.3.14" },
  ...clientPackageMetadata("packages/cli"),
};
const artifactSha256 = await clientPackageFingerprint(packageDirectory, packageManifest);
await writeFile(
  resolve(packageDirectory, "package.json"),
  `${JSON.stringify(
    {
      ...packageManifest,
      deploymentsArtifactSha256: artifactSha256,
    },
    null,
    2,
  )}\n`,
  "utf8",
);

console.log(`Built @agentifiers/deployments-cli@${cliPackage.version}.`);
