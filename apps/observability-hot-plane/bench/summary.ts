/**
 * Tabulates a compare.ts result file: per side and concurrency, the median and range across runs
 * of load p50, load p95, failed loads, 429 retries, peak ClickHouse memory, and CPU, and the
 * highest concurrency whose median load p95 is under the budget with no failed loads.
 *
 *   bun apps/observability-hot-plane/bench/summary.ts <label> [budget-ms]
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BENCH_DIR } from "./settings.ts";

const [label, budget = "2000"] = process.argv.slice(2);
if (!label) throw new Error("Usage: summary.ts <label> [budget-ms]");

interface Run {
  readonly apiCpuCores: number;
  readonly calls: number;
  readonly clickHouseCpuCores: number;
  readonly failedLoads: number;
  readonly label: string;
  readonly loadP50Ms: number;
  readonly loadP95Ms: number;
  readonly loads: number;
  readonly peakClickHouseAnonymousMiB: number;
  readonly peakClickHouseTrackedMiB: number;
  readonly throttledAttempts: number;
  readonly users: number;
}

const runs = readFileSync(join(BENCH_DIR, "results", `${label}.jsonl`), "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line) as Run);

const median = (values: readonly number[]) => {
  const sorted = values.toSorted((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};
const spread = (values: readonly number[]) =>
  `${median(values)} (${Math.min(...values)}-${Math.max(...values)})`;

const rows: string[] = [
  "| side | users | runs | load p50 ms | load p95 ms | failed loads % | 429 retries/load | peak tracked MiB | peak RSS MiB | ClickHouse cores |",
  "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
];
const sustained = new Map<string, number>();
const groups = Object.groupBy(runs, (run) => `${run.label}\u0000${run.users}`);
for (const [key, group = []] of Object.entries(groups).toSorted(([left], [right]) => {
  const [leftSide = "", leftUsers = "0"] = left.split("\u0000");
  const [rightSide = "", rightUsers = "0"] = right.split("\u0000");
  return leftSide.localeCompare(rightSide) || Number(leftUsers) - Number(rightUsers);
})) {
  const [side = "", users = "0"] = key.split("\u0000");
  const failed = group.map((run) => Math.round((100 * run.failedLoads) / Math.max(run.loads, 1)));
  const p95 = group.map((run) => run.loadP95Ms);
  if (median(p95) <= Number(budget) && Math.max(...failed) === 0) {
    sustained.set(side, Math.max(sustained.get(side) ?? 0, Number(users)));
  }
  rows.push(
    `| ${side} | ${users} | ${group.length} | ${spread(group.map((run) => run.loadP50Ms))} | ${spread(p95)} | ${spread(failed)} | ${spread(group.map((run) => Number((run.throttledAttempts / Math.max(run.loads, 1)).toFixed(1))))} | ${spread(group.map((run) => run.peakClickHouseTrackedMiB))} | ${spread(group.map((run) => run.peakClickHouseAnonymousMiB))} | ${spread(group.map((run) => run.clickHouseCpuCores))} |`,
  );
}
console.log(rows.join("\n"));
console.log();
for (const side of new Set(runs.map((run) => run.label))) {
  console.log(
    `${side}: sustains ${sustained.get(side) ?? 0} concurrent dashboard users at median load p95 <= ${budget} ms with no failed loads.`,
  );
}
