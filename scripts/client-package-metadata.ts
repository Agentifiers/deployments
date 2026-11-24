import { copyFile, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { renderClientPackageNotice, type ThirdPartyComponent } from "./client-package-notice.ts";

export const clientPackageRegistry = "https://registry.npmjs.org";
export const clientPackageLegalFiles = ["LICENSE", "NOTICE"] as const;

export function clientPackageMetadata(sourceDirectory: string) {
  return {
    license: "MIT",
    repository: {
      type: "git",
      url: "git+https://github.com/Agentifiers/deployments.git",
      directory: sourceDirectory,
    },
    publishConfig: { access: "public", registry: clientPackageRegistry },
  };
}

export async function writeClientPackageLegalFiles({
  sourceDirectory,
  packageDirectory,
  components,
}: {
  readonly sourceDirectory: string;
  readonly packageDirectory: string;
  readonly components: readonly ThirdPartyComponent[];
}) {
  await copyFile(resolve(sourceDirectory, "LICENSE"), resolve(packageDirectory, "LICENSE"));
  const packageNotice = await readFile(resolve(sourceDirectory, "NOTICE"), "utf8");
  await writeFile(
    resolve(packageDirectory, "NOTICE"),
    renderClientPackageNotice({ packageNotice, components }),
    "utf8",
  );
}
