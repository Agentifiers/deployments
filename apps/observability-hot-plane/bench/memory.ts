import { $ } from "bun";
import { readFileSync } from "node:fs";
import { adminExecutor } from "./executor.ts";
import { API_CONTAINER, CLICKHOUSE_CONTAINER } from "./settings.ts";

const MIB = 1_048_576;

async function cgroupDirectory(container: string) {
  const id = (
    await $`sh -c ${`${process.env.BENCH_DOCKER ?? "sudo -n docker"} inspect -f '{{.Id}}' ${container}`}`.text()
  ).trim();
  return `/sys/fs/cgroup/system.slice/docker-${id}.scope`;
}

const anonymousBytes = (directory: string) =>
  Number(/^anon (\d+)$/mu.exec(readFileSync(`${directory}/memory.stat`, "utf8"))?.[1] ?? 0);
const cpuMicroseconds = (directory: string) =>
  Number(/^usage_usec (\d+)$/mu.exec(readFileSync(`${directory}/cpu.stat`, "utf8"))?.[1] ?? 0);

/**
 * Samples ClickHouse's tracked memory (`MemoryTracking`) and the container's anonymous memory
 * every 250 ms until stopped, and reports the peaks and the mean CPU use, in cores, of the
 * ClickHouse and API containers.
 */
export function peakClickHouseMemory() {
  const clickhouse = adminExecutor();
  let running = true;
  let trackedMiB = 0;
  let cgroupMiB = 0;
  const sampling = (async () => {
    const [database, api] = await Promise.all([
      cgroupDirectory(CLICKHOUSE_CONTAINER),
      cgroupDirectory(API_CONTAINER),
    ]);
    const startedCpu = [cpuMicroseconds(database), cpuMicroseconds(api)] as const;
    const started = performance.now();
    while (running) {
      const [row] = await clickhouse.query<{ value: number }>(
        "SELECT toFloat64(value) AS value FROM system.metrics WHERE metric = 'MemoryTracking'",
      );
      trackedMiB = Math.max(trackedMiB, Math.round((row?.value ?? 0) / MIB));
      cgroupMiB = Math.max(cgroupMiB, Math.round(anonymousBytes(database) / MIB));
      await Bun.sleep(250);
    }
    const elapsedMs = performance.now() - started;
    const cores = (directory: string, from: number) =>
      Number(((cpuMicroseconds(directory) - from) / 1_000 / elapsedMs).toFixed(2));
    return { apiCores: cores(api, startedCpu[1]), cpuCores: cores(database, startedCpu[0]) };
  })();
  return {
    async stop() {
      running = false;
      return { cgroupMiB, trackedMiB, ...(await sampling) };
    },
  };
}
