import type { BunPlugin } from "bun";
import { copyFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

// libpg_query's Emscripten loader reads libpg-query.wasm from its CommonJS __dirname, which Bun
// inlines as the absolute path on the build machine.
const loadWasmBesideBundle: BunPlugin = {
  name: "load-libpg-query-wasm-beside-bundle",
  setup(build) {
    build.onLoad({ filter: /[\\/]libpg-query[\\/]wasm[\\/]libpg-query\.js$/u }, async (args) => ({
      contents: (await Bun.file(args.path).text()).replaceAll(
        /\b__(dirname|filename)\b/gu,
        "import.meta.$1",
      ),
      loader: "js",
    }));
  },
};

export async function buildFunctionBundle(outdir: string) {
  await rm(outdir, { force: true, recursive: true });
  const result = await Bun.build({
    entrypoints: [join(root, "src/index.ts")],
    format: "esm",
    naming: "[name].mjs",
    outdir,
    plugins: [loadWasmBesideBundle],
    target: "node",
  });
  if (!result.success) {
    throw new AggregateError(result.logs, "Failed to bundle the apps-database function.");
  }
  const packageDirectory = fileURLToPath(
    new URL("./", import.meta.resolve("@deployments-ai/app-database")),
  );
  const wasm = Bun.resolveSync("libpg-query/wasm/libpg-query.wasm", packageDirectory);
  await copyFile(wasm, join(outdir, "libpg-query.wasm"));
}

if (import.meta.main) await buildFunctionBundle(process.argv[2] ?? join(root, "dist"));
