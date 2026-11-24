import { describe, expect, test } from "bun:test";
import { createHotPlaneApi } from "./api.ts";
import type { ClickHouseExecutor } from "./clickhouse.ts";
import type { OrganizationErasure } from "./organization-erasure.ts";

const ORGANIZATION = "01HZ0000000000000000000000";
const headers = (organization = ORGANIZATION) => ({
  authorization: "Bearer internal-secret",
  "x-deployments-environment": "01ENVIRONMENT00000000000000",
  "x-deployments-organization": organization,
  "x-deployments-project": "01PROJECT00000000000000000",
});
const NOW = new Date("2026-08-03T00:00:00.000Z");
const WINDOW = "from=2026-08-02T00:00:00.000Z&to=2026-08-03T00:00:00.000Z";

/** ClickHouse whose queries stay running until released; it counts every query it starts. */
function heldClickHouse() {
  const started: string[] = [];
  const waiters: (() => void)[] = [];
  let release = Promise.withResolvers<void>();
  const clickhouse: ClickHouseExecutor = {
    execute: async () => undefined,
    insert: async () => undefined,
    query: async <T extends Readonly<Record<string, unknown>>>(
      _sql: string,
      parameters?: Readonly<Record<string, string>>,
    ) => {
      started.push(parameters?.organization ?? "");
      for (const waiter of waiters.splice(0)) waiter();
      await release.promise;
      return [] as readonly T[];
    },
  };
  return {
    clickhouse,
    release() {
      release.resolve();
      release = Promise.withResolvers<void>();
    },
    started,
    /** Resolves once `count` queries have started in total. */
    async untilStarted(count: number) {
      while (started.length < count) {
        const { promise, resolve } = Promise.withResolvers<void>();
        waiters.push(resolve);
        await promise;
      }
    },
  };
}

function api(
  clickhouse: ClickHouseExecutor,
  options: { now?: () => Date; organizationErasure?: OrganizationErasure } = {},
) {
  return createHotPlaneApi({
    clickhouse,
    now: options.now ?? (() => NOW),
    organizationErasure: options.organizationErasure ?? {
      erase: () => Promise.reject(new Error("Erasure is not exercised here.")),
    },
    serviceToken: "internal-secret",
  });
}

describe("hot-plane query capacity", () => {
  test("queues an organization's queries beyond its two slots instead of refusing them", async () => {
    const hot = heldClickHouse();
    const app = api(hot.clickhouse);
    const requests = [1, 2, 3].map((index) =>
      app.request(`/traces?${WINDOW}&limit=${index}`, { headers: headers() }),
    );
    await hot.untilStarted(2);
    const other = app.request(`/traces?${WINDOW}`, {
      headers: headers("01OTHERORGANIZATION000000000"),
    });
    await hot.untilStarted(3);
    expect(hot.started).toEqual([ORGANIZATION, ORGANIZATION, "01OTHERORGANIZATION000000000"]);
    hot.release();
    await hot.untilStarted(4);
    hot.release();
    const statuses = await Promise.all([...requests, other].map(async (r) => (await r).status));
    expect(statuses).toEqual([200, 200, 200, 200]);
  });

  test("caps running queries across organizations at four", async () => {
    const hot = heldClickHouse();
    const app = api(hot.clickhouse);
    const organizations = ["01A", "01B", "01C", "01D", "01E"].map((prefix) =>
      prefix.padEnd(26, "0"),
    );
    const requests = organizations.map((organization) =>
      Promise.resolve(app.request(`/traces?${WINDOW}`, { headers: headers(organization) })),
    );
    await hot.untilStarted(4);
    await Bun.sleep(20);
    expect(hot.started).toHaveLength(4);
    hot.release();
    await hot.untilStarted(5);
    hot.release();
    expect((await Promise.all(requests)).map((response) => response.status)).toEqual([
      200, 200, 200, 200, 200,
    ]);
  });

  test("refuses a query that waits longer than three seconds with a retryable 429", async () => {
    const hot = heldClickHouse();
    const app = api(hot.clickhouse);
    const running = [1, 2].map((index) =>
      Promise.resolve(app.request(`/traces?${WINDOW}&limit=${index}`, { headers: headers() })),
    );
    await hot.untilStarted(2);
    const refused = await app.request(`/traces?${WINDOW}&limit=3`, { headers: headers() });
    expect(refused.status).toBe(429);
    expect(refused.headers.get("content-type")).toContain("application/problem+json");
    expect(await refused.json()).toMatchObject({
      code: "observability_query_concurrency_exceeded",
      status: 429,
    });
    hot.release();
    expect((await Promise.all(running)).map((response) => response.status)).toEqual([200, 200]);
  });
});

describe("hot-plane aggregate cache", () => {
  function countingClickHouse(rows: readonly Readonly<Record<string, unknown>>[] = []) {
    const queries: Readonly<Record<string, string>>[] = [];
    const clickhouse: ClickHouseExecutor = {
      execute: async () => undefined,
      insert: async () => undefined,
      query: async <T extends Readonly<Record<string, unknown>>>(
        _sql: string,
        parameters?: Readonly<Record<string, string>>,
      ) => {
        queries.push(parameters ?? {});
        return rows as readonly T[];
      },
    };
    return { clickhouse, queries };
  }

  test("serves a repeated metrics request from the cache for ten seconds", async () => {
    const hot = countingClickHouse([
      { bucket: "2026-08-02 00:00:00", group_value: "", trace_count: 3 },
    ]);
    let now = NOW;
    const app = api(hot.clickhouse, { now: () => now });
    const first = await app.request(`/metrics?${WINDOW}&interval=day`, { headers: headers() });
    // Parameter order does not change the cached query.
    const reordered = await app.request(`/metrics?interval=day&${WINDOW}`, { headers: headers() });
    expect(await reordered.json()).toEqual(await first.json());
    expect(reordered.headers.get("content-type")).toContain("application/json");
    expect(hot.queries).toHaveLength(1);
    now = new Date(NOW.getTime() + 10_000);
    await app.request(`/metrics?${WINDOW}&interval=day`, { headers: headers() });
    expect(hot.queries).toHaveLength(2);
  });

  test("never shares a cached aggregate across tenants or caches traces and failures", async () => {
    const hot = countingClickHouse();
    const app = api(hot.clickhouse);
    await app.request(`/tools?${WINDOW}`, { headers: headers() });
    await app.request(`/tools?${WINDOW}`, { headers: headers("01OTHERORGANIZATION000000000") });
    await app.request(`/tools?${WINDOW}`, {
      headers: { ...headers(), "x-deployments-environment": "01OTHERENVIRONMENT0000000000" },
    });
    expect(hot.queries.map((query) => [query.organization, query.environment])).toEqual([
      [ORGANIZATION, "01ENVIRONMENT00000000000000"],
      ["01OTHERORGANIZATION000000000", "01ENVIRONMENT00000000000000"],
      [ORGANIZATION, "01OTHERENVIRONMENT0000000000"],
    ]);
    await app.request(`/traces?${WINDOW}`, { headers: headers() });
    await app.request(`/traces?${WINDOW}`, { headers: headers() });
    expect(hot.queries).toHaveLength(5);

    let failures = 0;
    const failing = api({
      ...hot.clickhouse,
      query: async () => {
        failures += 1;
        throw new Error("ClickHouse is unavailable.");
      },
    });
    expect((await failing.request(`/tools?${WINDOW}`, { headers: headers() })).status).toBe(500);
    expect((await failing.request(`/tools?${WINDOW}`, { headers: headers() })).status).toBe(500);
    expect(failures).toBe(2);
  });

  test("drops an organization's cached aggregates when its erasure is requested", async () => {
    const hot = countingClickHouse();
    const app = api(hot.clickhouse, {
      organizationErasure: {
        erase: async () => ({
          rowsDeleted: 1,
          status: "complete",
          tables: [{ rowsDeleted: 1, table: "facts" }],
          verifiedAt: NOW.toISOString(),
        }),
      },
    });
    await app.request(`/metrics?${WINDOW}`, { headers: headers() });
    const erasure = await app.request("/internal/organization-erasures", {
      body: JSON.stringify({
        drainAnchorAt: NOW.toISOString(),
        operationId: "01HZ0000000000000000000001",
        organizationId: ORGANIZATION,
      }),
      headers: { authorization: "Bearer internal-secret" },
      method: "POST",
    });
    expect(erasure.status).toBe(200);
    await app.request(`/metrics?${WINDOW}`, { headers: headers() });
    expect(hot.queries).toHaveLength(2);
  });
});
