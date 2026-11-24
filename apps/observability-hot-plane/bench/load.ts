/**
 * Closed-loop dashboard load against the hot-plane API. Each of N virtual users repeatedly opens
 * a dashboard for its own tenant: the console's environment overview, metrics screen, and trace
 * list, the three server functions in parallel. Each function calls the hot plane the way
 * hot-plane-queue.ts does: at most two calls in flight, and a 429 retried after 250, 750, and
 * 1,500 ms plus jitter. A load's latency is the time until all three screens have their data.
 *
 * Users rotate through the 100 tenants (50 organizations x 2 environments), and every load shifts
 * its window end by a unique millisecond, so a repeated load never reuses an earlier load's
 * response; only the screens of one load share identical queries, as they do in the console.
 *
 *   bun apps/observability-hot-plane/bench/load.ts <label> <users,...> [seconds]
 *
 * Options: `--ref <commit>` serves the hot-plane API from that commit (default: this worktree),
 * so a before and after run differ only in the code under test.
 *
 * Prints one JSON line per concurrency level.
 */
import { parseArgs } from "node:util";
import { startApi } from "./api.ts";
import { peakClickHouseMemory } from "./memory.ts";
import {
  API_PORT,
  environmentId,
  organizationId,
  ORGANIZATIONS,
  PROJECT_ID,
  SERVICE_TOKEN,
} from "./settings.ts";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { ref: { type: "string" } },
});
const [label = "run", levels = "1,2,4,8,16,32", seconds = "20"] = positionals;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const RETRY_DELAYS_MS = [250, 750, 1_500];

interface CallResult {
  readonly milliseconds: number;
  readonly route: string;
  readonly status: number;
  readonly throttled: number;
}

const TENANTS = ORGANIZATIONS * 2;
let loadSequence = 0;

/** The 24-hour window console metricWindow() asks for, ending a unique millisecond late. */
function dayWindow() {
  loadSequence += 1;
  const to = (Math.floor((Date.now() + 2 * 60_000) / HOUR) + 1) * HOUR + (loadSequence % 60_000);
  return { from: new Date(to - DAY).toISOString(), to: new Date(to).toISOString() };
}

function createQueue(tenant: number, results: CallResult[]) {
  const organization = tenant % ORGANIZATIONS;
  const headers = {
    authorization: `Bearer ${SERVICE_TOKEN}`,
    "x-deployments-environment": environmentId(organization, Math.floor(tenant / ORGANIZATIONS)),
    "x-deployments-organization": organizationId(organization),
    "x-deployments-project": PROJECT_ID,
  };
  let active = 0;
  const waiting: (() => void)[] = [];
  async function gated(path: string) {
    while (active >= 2) {
      const slot = Promise.withResolvers<void>();
      waiting.push(slot.resolve);
      await slot.promise;
    }
    active += 1;
    try {
      const response = await fetch(`http://127.0.0.1:${API_PORT}${path}`, { headers });
      const body = await response.text();
      if (response.status === 200 && !body.startsWith('{"')) throw new Error(`Bad body: ${body}`);
      return response.status;
    } finally {
      active -= 1;
      waiting.shift()?.();
    }
  }
  return async (path: string) => {
    const started = performance.now();
    let throttled = 0;
    for (let attempt = 0; ; attempt += 1) {
      const status = await gated(path).catch(() => 599);
      const delay = RETRY_DELAYS_MS[attempt];
      if (status === 429 && delay) {
        throttled += 1;
        await Bun.sleep(delay + Math.random() * delay);
        continue;
      }
      results.push({
        milliseconds: performance.now() - started,
        route: path.slice(0, path.indexOf("?")),
        status,
        throttled,
      });
      return status;
    }
  };
}

/** The hot-plane calls of each screen's server function, issued through one queue per screen. */
function dashboardScreens(from: string, to: string) {
  const range = `from=${from}&to=${to}`;
  const now = Date.now();
  return [
    [
      `/metrics?${range}&interval=hour`,
      `/metrics?${range}&interval=day&groupBy=agentDeploymentId`,
      `/tools?${range}`,
      `/traces?${range}&limit=10&status=error`,
    ],
    [`/metrics?${range}&interval=hour`, `/tools?${range}`],
    [
      `/traces?from=${new Date(now - DAY).toISOString()}&to=${new Date(now).toISOString()}&limit=50`,
    ],
  ];
}

async function dashboardLoad(tenant: number, results: CallResult[]) {
  const { from, to } = dayWindow();
  const statuses = await Promise.all(
    dashboardScreens(from, to).flatMap((paths) => {
      const call = createQueue(tenant, results);
      return paths.map((path) => call(path));
    }),
  );
  return statuses.every((status) => status === 200);
}

function percentile(values: readonly number[], fraction: number) {
  if (values.length === 0) return Number.NaN;
  const sorted = values.toSorted((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)]!;
}

async function level(users: number) {
  const results: CallResult[] = [];
  const loads: { readonly milliseconds: number; readonly ok: boolean }[] = [];
  const deadline = performance.now() + Number(seconds) * 1_000;
  const memory = peakClickHouseMemory();
  await Promise.all(
    Array.from({ length: users }, async (_, user) => {
      for (let iteration = 0; performance.now() < deadline; iteration += 1) {
        const started = performance.now();
        const ok = await dashboardLoad((user + iteration * users) % TENANTS, results);
        loads.push({ milliseconds: performance.now() - started, ok });
      }
    }),
  );
  const peak = await memory.stop();
  const latencies = loads.map((load) => load.milliseconds);
  const failedCalls = results.filter((result) => result.status !== 200);
  return {
    label,
    ref: values.ref ?? "worktree",
    users,
    loads: loads.length,
    failedLoads: loads.filter((load) => !load.ok).length,
    loadP50Ms: Math.round(percentile(latencies, 0.5)),
    loadP95Ms: Math.round(percentile(latencies, 0.95)),
    calls: results.length,
    failedCalls: failedCalls.length,
    failedStatuses: Object.fromEntries(
      Object.entries(Object.groupBy(failedCalls, (result) => String(result.status))).map(
        ([status, items]) => [status, items?.length ?? 0],
      ),
    ),
    throttledAttempts: results.reduce((sum, result) => sum + result.throttled, 0),
    callP95MsByRoute: Object.fromEntries(
      Object.entries(Object.groupBy(results, (result) => result.route)).map(([route, items]) => [
        route,
        Math.round(
          percentile(
            (items ?? []).map((item) => item.milliseconds),
            0.95,
          ),
        ),
      ]),
    ),
    peakClickHouseTrackedMiB: peak.trackedMiB,
    peakClickHouseAnonymousMiB: peak.cgroupMiB,
    clickHouseCpuCores: peak.cpuCores,
    apiCpuCores: peak.apiCores,
  };
}

const api = await startApi(values.ref);
try {
  for (const users of levels.split(",").map(Number)) {
    console.log(JSON.stringify(await level(users)));
  }
} finally {
  await api.stop();
}
