import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const currentDirectory = dirname(fileURLToPath(import.meta.url));

export const repositoryRoot = resolve(currentDirectory, "../../../..");
export const cliEntryPoint = resolve(repositoryRoot, "packages/cli/src/bin.ts");
