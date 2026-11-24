import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const outdir = join(root, "dist");
const entrypoints = [
  join(root, "../worker/src/usage-main.ts"),
  join(root, "../worker/src/artifact-retention-main.ts"),
  join(root, "../worker/src/trace-finalization-main.ts"),
  join(root, "../worker/src/model-catalog-sync-main.ts"),
  join(root, "../worker/src/evaluation-worker-main.ts"),
  join(root, "../worker/src/observability-normalizer-main.ts"),
  join(root, "../worker/src/observability-projector-main.ts"),
  join(root, "../worker/src/observability-erasure-main.ts"),
  join(root, "../worker/src/client-tool-timeout-main.ts"),
  join(root, "../worker/src/model-token-issuer-main.ts"),
  join(root, "src/runtime-api-main.ts"),
  join(root, "src/schedule-fire.ts"),
  join(root, "src/heartbeat-fire.ts"),
  join(root, "src/run-dispatch.ts"),
  join(root, "src/webhook-event-handler.ts"),
  join(root, "src/alert-event-handler.ts"),
  join(root, "../workflow-runtime/src/queue-main.ts"),
  join(root, "../workflow-runtime/src/event-router-main.ts"),
  join(root, "../workflow-runtime/src/approval-timeout-main.ts"),
];

// Bun.build supports the `dataurl` loader (the worker Dockerfile uses `--loader .woff:dataurl`),
// but bun-types omits it from `Bun.Loader`; this is the one place the declared union is widened.
const fontDataUrlLoader = "dataurl" as Bun.Loader;

await rm(outdir, { force: true, recursive: true });
for (const entrypoint of entrypoints) {
  const result = await Bun.build({
    entrypoints: [entrypoint],
    format: "esm",
    loader: { ".woff": fontDataUrlLoader },
    naming: "[name].mjs",
    outdir,
    target: "node",
  });
  if (!result.success) {
    throw new AggregateError(result.logs, `Failed to bundle ${entrypoint}.`);
  }
}
