/**
 * Alternates a baseline commit and this worktree, `rounds` times each, against the running bench
 * ClickHouse: before each run it applies that side's users profile, then runs load.ts with that
 * side's hot-plane API. Results append to `<BENCH_DIR>/results/<label>.jsonl`; summary.ts
 * tabulates them.
 *
 *   bun apps/observability-hot-plane/bench/compare.ts <label> <baseline-commit> <users,...> [seconds] [rounds]
 */
import { $ } from "bun";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { BENCH_DIR } from "./settings.ts";

const [label, baseline, levels, seconds = "15", rounds = "5"] = process.argv.slice(2);
if (!label || !baseline || !levels) {
  throw new Error("Usage: compare.ts <label> <baseline-commit> <users,...> [seconds] [rounds]");
}
const results = join(BENCH_DIR, "results");
mkdirSync(results, { recursive: true });
const output = join(results, `${label}.jsonl`);
const bench = import.meta.dir;

for (let round = 0; round < Number(rounds); round += 1) {
  for (const side of round % 2 === 0 ? [baseline, "worktree"] : ["worktree", baseline]) {
    const ref = side === "worktree" ? [] : [side];
    await $`bun ${join(bench, "clickhouse.ts")} configure ${ref}`;
    const lines =
      await $`bun ${join(bench, "load.ts")} ${`${label}-${side}`} ${levels} ${seconds} ${ref.length ? ["--ref", side] : []}`.text();
    appendFileSync(output, lines);
    process.stdout.write(lines);
  }
}
await $`bun ${join(bench, "clickhouse.ts")} configure`;
