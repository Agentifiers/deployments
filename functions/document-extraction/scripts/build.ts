import { rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CHILD_BUNDLE_FILE } from "../src/child-protocol.ts";

const root = fileURLToPath(new URL("../", import.meta.url));

export async function buildFunctionBundle(outdir: string) {
  await rm(outdir, { force: true, recursive: true });
  const result = await Bun.build({
    entrypoints: [join(root, "src/handler.ts"), join(root, "src/child.ts")],
    format: "esm",
    naming: "[name].mjs",
    outdir,
    target: "node",
  });
  if (!result.success) {
    throw new AggregateError(result.logs, "Failed to bundle the document extraction function.");
  }
  if (!result.outputs.some(({ path }) => basename(path) === CHILD_BUNDLE_FILE)) {
    throw new Error(`The bundle has no ${CHILD_BUNDLE_FILE} for the handler to spawn.`);
  }
}

if (import.meta.main) await buildFunctionBundle(process.argv[2] ?? join(root, "dist"));
