import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The build runs in its own Bun process: a second `Bun.build` inside one test process fails
 * to re-read modules the tests already loaded.
 */
export async function buildBundleForTest() {
  const outdir = await mkdtemp(join(tmpdir(), "document-extraction-bundle-"));
  const build = Bun.spawnSync(["bun", join(import.meta.dir, "../../scripts/build.ts"), outdir], {
    stderr: "pipe",
  });
  if (!build.success) throw new Error(`Bundle build failed: ${build.stderr.toString()}`);
  return outdir;
}
