import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { makePublicOpenApiSpec } from "@deployments-ai/api-contract/openapi";

const outputPath = resolve(
  process.cwd(),
  process.argv[2] ?? "packages/api-contract/dist/openapi.json",
);

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(makePublicOpenApiSpec(), null, 2)}\n`, "utf8");

console.log(outputPath);
