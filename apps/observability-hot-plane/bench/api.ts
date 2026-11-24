import { $ } from "bun";
import { cpSync, existsSync, mkdirSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { API_CONTAINER, API_PORT, BENCH_DIR, SERVICE_TOKEN } from "./settings.ts";

const WORKTREE = resolve(import.meta.dir, "../../..");
const APP = "apps/observability-hot-plane";
const DOCKER = process.env.BENCH_DOCKER ?? "sudo -n docker";

/**
 * The hot-plane sources at `ref`, with this worktree's bench scripts and installed dependencies,
 * so an older commit runs the same harness. Without a ref, the worktree itself.
 */
async function sourceTree(ref: string | undefined) {
  if (!ref) return WORKTREE;
  const commit = (await $`git -C ${WORKTREE} rev-parse --short ${ref}`.text()).trim();
  const tree = join(BENCH_DIR, `ref-${commit}`);
  if (!existsSync(tree)) {
    mkdirSync(tree, { recursive: true });
    await $`git -C ${WORKTREE} archive ${commit} ${APP}/src packages/observability | tar -x -C ${tree}`;
    cpSync(join(WORKTREE, APP, "bench"), join(tree, APP, "bench"), { recursive: true });
    symlinkSync(join(WORKTREE, "node_modules"), join(tree, "node_modules"));
    symlinkSync(join(WORKTREE, APP, "node_modules"), join(tree, APP, "node_modules"));
  }
  return tree;
}

/**
 * Runs bench/server.ts in a container sized like the dev ECS task (task_size 256/512: a quarter
 * vCPU and 512 MiB), so the API is no faster than in dev.
 */
export async function startApi(ref?: string) {
  const tree = await sourceTree(ref);
  const bun = (await $`bun --version`.text()).trim();
  await $`sh -c ${`${DOCKER} rm -f ${API_CONTAINER} >/dev/null 2>&1; true`}`;
  await $`sh -c ${[
    `${DOCKER} run -d --name ${API_CONTAINER} --network host --cpus 0.25 --memory 512m`,
    `-e BENCH_DIR=/bench -v ${BENCH_DIR}:/bench:ro`,
    `-v ${WORKTREE}:${WORKTREE}:ro -v ${tree}:${tree}:ro -w ${tree}/${APP}`,
    `oven/bun:${bun} bun bench/server.ts`,
  ].join(" ")}`.quiet();
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const response = await fetch(`http://127.0.0.1:${API_PORT}/ready`, {
      headers: { authorization: `Bearer ${SERVICE_TOKEN}` },
    }).catch(() => undefined);
    if (response?.ok) {
      return {
        stop: () => $`sh -c ${`${DOCKER} rm -f ${API_CONTAINER}`}`.quiet().nothrow(),
      };
    }
    await Bun.sleep(500);
  }
  throw new Error("The bench hot-plane API did not become ready.");
}
