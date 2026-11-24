import { describe, expect, test } from "bun:test";
import { operatorAccessGrant } from "@deployments-ai/db/operator-access-testing";
import {
  ApiCredentialUsageRecord,
  MeterEventRecord,
  UsageAggregateRecord,
  UsageCounterShardRecord,
  ProviderBillingPeriodRecord,
  type DynamoDatabaseService,
  type PlatformRecord,
} from "@deployments-ai/db";
import {
  CREDENTIAL_ID,
  ENVIRONMENT_ID,
  EVENT_ID,
  NOW,
  ORGANIZATION_ID,
  PRINCIPAL_ID,
  PROJECT_ID,
  counterShard,
  cursorCodec,
  database,
  fixtureRecords,
  invocation,
  operationalService,
  record,
} from "./operational-reads.fixture.ts";

function stringField(value: unknown): string {
  if (typeof value !== "string")
    throw new TypeError(`Expected a string field, got ${typeof value}.`);
  return value;
}

describe("tenant operational reads", () => {
  test("projects usage, cost, and spend records without DynamoDB keys", async () => {
    const service = operationalService(database(fixtureRecords()));

    expect(service.listUsage(invocation)).resolves.toMatchObject({
      items: [{ type: "usage-counter-shard", data: { metric: "model.tokens", quantity: 12 } }],
    });
    expect(service.listCosts(invocation)).resolves.toMatchObject({
      items: [{ type: "cost-aggregate", data: { source: "model", totalMinor: 7 } }],
    });
    expect(service.listSpend(invocation)).resolves.toMatchObject({
      items: [{ type: "spend-ledger", data: { provider: "openai" } }],
    });
    expect((await service.listUsage(invocation)).items[0]).not.toHaveProperty("pk");
  });

  test("filters reporting aggregates by their bucket instead of creation time", async () => {
    const records = fixtureRecords().map((item) =>
      item.itemType === "cost-aggregate"
        ? {
            ...item,
            data: { ...item.data, createdAt: "2026-01-01T00:00:00.000Z" },
          }
        : item,
    ) as readonly PlatformRecord[];
    const service = operationalService(database(records));

    expect(
      service.listCosts({
        ...invocation,
        query: {
          since: "2026-07-25T00:00:00.000Z",
          until: "2026-07-26T00:00:00.000Z",
        },
      }),
    ).resolves.toMatchObject({
      items: [{ type: "cost-aggregate", data: { bucket: NOW } }],
    });
  });

  test("keeps cost-bearing shards and dimensions behind spend authorization", async () => {
    const records = [
      ...fixtureRecords(),
      // The meter event's own counter: materialization writes one per event metric.
      counterShard("model_tokens", NOW, 1, 12, "tokens"),
      record(UsageCounterShardRecord, {
        data: {
          bucket: NOW,
          environmentId: ENVIRONMENT_ID,
          metric: "model_tokens.cost_usd_micros",
          organizationId: ORGANIZATION_ID,
          projectId: PROJECT_ID,
          quantity: 25,
          shard: 1,
          unit: "usd_micros",
          updatedAt: NOW,
          version: 0,
        },
        itemType: "usage-counter-shard",
      }),
      record(UsageCounterShardRecord, {
        data: {
          bucket: NOW,
          environmentId: ENVIRONMENT_ID,
          metric: "model_tokens.cost_usd_nanodollars",
          organizationId: ORGANIZATION_ID,
          projectId: PROJECT_ID,
          quantity: 25_000,
          shard: 1,
          unit: "usd_nanodollars",
          updatedAt: NOW,
          version: 0,
        },
        itemType: "usage-counter-shard",
      }),
      record(UsageAggregateRecord, {
        data: {
          bucket: NOW,
          createdAt: NOW,
          environmentId: ENVIRONMENT_ID,
          metric: "model_tokens.cost_usd_micros",
          organizationId: ORGANIZATION_ID,
          projectId: PROJECT_ID,
          quantity: 50,
          unit: "usd_micros",
          updatedAt: NOW,
          version: 0,
        },
        itemType: "usage-aggregate",
      }),
      record(MeterEventRecord, {
        data: {
          dimensions: {
            costUsdMicros: 25,
            costUsdNanoDollars: 25_000,
            modelId: "openai/gpt-5",
          },
          environmentId: ENVIRONMENT_ID,
          id: "01ARZ3NDEKTSV4RRFFQ69G5FB1",
          idempotencyKey: "call-1",
          metric: "model_tokens",
          occurredAt: NOW,
          organizationId: ORGANIZATION_ID,
          projectId: PROJECT_ID,
          quantity: 12,
          source: "model",
          unit: "tokens",
        },
        itemType: "meter-event",
      }),
    ];
    const service = operationalService(database(records));
    const usage = await service.listUsage(invocation);
    const meterEvent = usage.items.find((item) => item.type === "meter-event");

    expect(
      usage.items.some(
        (item) =>
          (item.type === "usage-counter-shard" || item.type === "usage-aggregate") &&
          item.data.metric === "model_tokens.cost_usd_micros",
      ),
    ).toBe(false);
    expect(
      usage.items.some(
        (item) =>
          item.type === "usage-counter-shard" &&
          item.data.metric === "model_tokens.cost_usd_nanodollars",
      ),
    ).toBe(false);
    expect(meterEvent?.data.dimensions).toEqual({ modelId: "openai/gpt-5" });
    const costs = await service.listCosts(invocation);
    expect(
      costs.items.find(
        (item) =>
          item.type === "usage-counter-shard" &&
          item.data.metric === "model_tokens.cost_usd_micros",
      ),
    ).toMatchObject({
      type: "usage-counter-shard",
      data: { metric: "model_tokens.cost_usd_micros", quantity: 25 },
    });
    expect(
      costs.items.find(
        (item) =>
          item.type === "usage-counter-shard" &&
          item.data.metric === "model_tokens.cost_usd_nanodollars",
      ),
    ).toMatchObject({
      type: "usage-counter-shard",
      data: { metric: "model_tokens.cost_usd_nanodollars", quantity: 25_000 },
    });
    expect(
      costs.items.find(
        (item) =>
          item.type === "usage-aggregate" && item.data.metric === "model_tokens.cost_usd_micros",
      ),
    ).toMatchObject({
      type: "usage-aggregate",
      data: { metric: "model_tokens.cost_usd_micros", quantity: 50 },
    });
  });

  test("lists and gets environment-scoped audit events", async () => {
    const service = operationalService(database(fixtureRecords()));

    expect(service.listAuditEvents(invocation)).resolves.toMatchObject({
      items: [{ id: EVENT_ID, action: "api-key.rotated", actor: { id: PRINCIPAL_ID } }],
    });
    expect(service.getAuditEvent({ ...invocation, id: EVENT_ID })).resolves.toMatchObject({
      id: EVENT_ID,
      resourceId: CREDENTIAL_ID,
    });
  });

  test("continues through unrelated physical pages until it fills the filtered page", async () => {
    const records = fixtureRecords();
    const base = database(records);
    const audit = records.find((item) => item.itemType === "audit-event")!;
    const unrelated = records.find((item) => item.itemType === "usage-counter-shard")!;
    let eventQueries = 0;
    const pagedDatabase: DynamoDatabaseService = {
      ...base,
      queryRecords: (table, input) => {
        if (table !== "events") return base.queryRecords(table, input);
        eventQueries += 1;
        return Promise.resolve(
          eventQueries === 1
            ? {
                items: [unrelated],
                lastEvaluatedKey: { pk: unrelated.pk, sk: unrelated.sk },
              }
            : { items: [audit] },
        );
      },
    };
    const service = operationalService(pagedDatabase);

    expect(service.listAuditEvents(invocation)).resolves.toMatchObject({
      items: [{ id: EVENT_ID }],
    });
    expect(eventQueries).toBe(2);
  });

  test("bounds sparse physical reads and returns a continuation cursor", async () => {
    const records = fixtureRecords();
    const base = database(records);
    const unrelated = records.find((item) => item.itemType === "usage-counter-shard")!;
    let eventQueries = 0;
    const pagedDatabase: DynamoDatabaseService = {
      ...base,
      queryRecords: (table, input) => {
        if (table !== "events") return base.queryRecords(table, input);
        eventQueries += 1;
        return Promise.resolve({
          items: [unrelated],
          lastEvaluatedKey: { pk: unrelated.pk, sk: `${unrelated.sk}#${eventQueries}` },
        });
      },
    };
    const service = operationalService(pagedDatabase);

    const page = await service.listAuditEvents(invocation);
    expect(page).toMatchObject({
      items: [],
      nextCursor: expect.any(String),
    });
    expect(() => JSON.parse(Buffer.from(page.nextCursor!, "base64url").toString("utf8"))).toThrow();
    const forgedCursor = Buffer.from(
      JSON.stringify({ key: { pk: unrelated.pk, sk: unrelated.sk } }),
      "utf8",
    ).toString("base64url");
    expect(
      service.listAuditEvents({
        ...invocation,
        query: { cursor: forgedCursor },
      }),
    ).rejects.toMatchObject({ code: "invalid_cursor", status: 400 });
    expect(eventQueries).toBe(10);
  });

  test("lists API-credential activity without request fingerprint keys", async () => {
    const service = operationalService(database(fixtureRecords()));
    expect(
      service.listApiCredentialUsage({
        ...invocation,
        query: { apiCredentialId: CREDENTIAL_ID },
      }),
    ).resolves.toMatchObject({
      items: [
        {
          type: "api-credential-usage",
          data: { apiCredentialId: CREDENTIAL_ID, outcome: "allowed" },
        },
      ],
    });
  });

  test("rejects a credential outside the requested environment", async () => {
    const service = operationalService(database(fixtureRecords()));
    expect(
      service.listUsage({
        ...invocation,
        identity: { ...invocation.identity, environmentIds: [] },
      }),
    ).rejects.toMatchObject({ code: "environment_scope_violation", status: 403 });
  });

  test("holds a platform-wide scope to the environment grant the authenticator resolved", async () => {
    const service = operationalService(database(fixtureRecords()));

    expect(
      service.listUsage({
        ...invocation,
        identity: {
          organizationIds: [ORGANIZATION_ID],
          principalId: PRINCIPAL_ID,
          projectIds: [PROJECT_ID],
          scopes: ["platform:admin"],
        },
      }),
    ).rejects.toMatchObject({ code: "environment_scope_violation" });
    expect(
      service.listUsage({
        ...invocation,
        identity: {
          environmentIds: [ENVIRONMENT_ID],
          operatorAccess: operatorAccessGrant(ORGANIZATION_ID),
          organizationIds: [ORGANIZATION_ID],
          platformRole: "administrator",
          principalId: PRINCIPAL_ID,
          projectIds: [PROJECT_ID],
          scopes: ["platform:admin"],
        },
      }),
    ).resolves.toMatchObject({
      items: [{ type: "usage-counter-shard", data: { metric: "model.tokens" } }],
    });
  });
});

describe("usage lists over the metric index", () => {
  const window = { since: "2026-07-25T00:00:00.000Z", until: "2026-07-26T00:00:00.000Z" };

  function apiActivity(count: number) {
    return Array.from({ length: count }, (_, index) =>
      record(ApiCredentialUsageRecord, {
        data: {
          apiCredentialId: CREDENTIAL_ID,
          createdAt: NOW,
          environmentId: ENVIRONMENT_ID,
          id: `01ARZ3NDEKTSV4RRFFQ6${String(index).padStart(6, "0")}`,
          organizationId: ORGANIZATION_ID,
          outcome: "allowed",
          projectId: PROJECT_ID,
          requestMethod: "GET",
          requestPath: "/v1/runs",
        },
        itemType: "api-credential-usage",
      }),
    );
  }

  /** Follows `nextCursor` to the end; a list that never ends fails the test. */
  async function allPages(
    service: ReturnType<typeof operationalService>,
    query: Readonly<Record<string, string | number>>,
  ) {
    const items: { readonly data: Readonly<Record<string, unknown>> }[] = [];
    let cursor: string | undefined;
    for (let pages = 0; pages < 20; pages += 1) {
      const page = await service.listUsage({
        ...invocation,
        query: { ...query, ...(cursor ? { cursor } : {}) },
      });
      items.push(...page.items);
      cursor = page.nextCursor;
      if (!cursor) return items;
    }
    throw new Error("The list did not end.");
  }

  test("reads only the window's records: since inclusive, until exclusive", async () => {
    const read: number[] = [];
    const records = [
      ...fixtureRecords(),
      ...apiActivity(200),
      counterShard("worker_ms", "2026-07-24T23:00:00.000Z", 0, 1, "ms"),
      counterShard("worker_ms", window.since, 0, 2, "ms"),
      counterShard("worker_ms", "2026-07-25T18:00:00.000Z", 3, 3, "ms"),
      counterShard("worker_ms", window.until, 0, 4, "ms"),
    ];
    const page = await operationalService(database(records, read)).listUsage({
      ...invocation,
      query: window,
    });

    expect(
      page.items
        .map((item) => `${stringField(item.data.metric)}@${stringField(item.data.bucket)}`)
        .toSorted(),
    ).toEqual([
      `model.tokens@${NOW}`,
      `worker_ms@${window.since}`,
      "worker_ms@2026-07-25T18:00:00.000Z",
    ]);
    expect(page.nextCursor).toBeUndefined();
    // One discovery read per metric plus the window's records; API activity is never read.
    expect(read.reduce((sum, count) => sum + count, 0)).toBe(page.items.length + 2);
  });

  test("pages across metrics without losing or repeating records", async () => {
    const records = [
      ...fixtureRecords(),
      ...[0, 1, 2].map((shard) => counterShard("a_metric", NOW, shard, shard + 1, "count")),
      ...[0, 1].map((shard) => counterShard("b_metric", NOW, shard, shard + 1, "count")),
    ];
    const items = await allPages(operationalService(database(records)), { ...window, limit: 2 });

    expect(
      items.map((item) => `${String(item.data.metric)}#${String(item.data.shard)}`).toSorted(),
    ).toEqual([
      "a_metric#0",
      "a_metric#1",
      "a_metric#2",
      "b_metric#0",
      "b_metric#1",
      "model.tokens#0",
    ]);
  });

  test("reads nothing ahead while it continues a metric with more records", async () => {
    const read: number[] = [];
    const records = [
      ...fixtureRecords(),
      ...Array.from({ length: 250 }, (_, shard) =>
        counterShard("a_metric", NOW, shard, 1, "count"),
      ),
      ...[0, 1, 2].map((shard) => counterShard("b_metric", NOW, shard, 1, "count")),
    ];
    const service = operationalService(database(records, read));
    const first = await service.listUsage({ ...invocation, query: { ...window, limit: 100 } });
    read.length = 0;
    const second = await service.listUsage({
      ...invocation,
      query: { ...window, cursor: first.nextCursor!, limit: 100 },
    });

    expect(second.items).toHaveLength(100);
    expect(read).toEqual([100]);
    const rest = await allPages(service, { ...window, cursor: second.nextCursor!, limit: 100 });
    const keys = [...first.items, ...second.items, ...rest].map(
      (item) => `${String(item.data.metric)}#${String(item.data.shard)}`,
    );
    expect(new Set(keys).size).toBe(254);
    expect(keys).toHaveLength(254);
  });

  test("rejects a cursor that points into another environment's metric index", async () => {
    const records = [
      ...fixtureRecords(),
      ...[0, 1, 2].map((shard) => counterShard("a_metric", NOW, shard, 1, "count")),
    ];
    const service = operationalService(database(records));
    const first = await service.listUsage({ ...invocation, query: { ...window, limit: 1 } });
    const cursor = JSON.parse(await cursorCodec.open(first.nextCursor!)) as {
      position: { key: Record<string, string>; metric: string };
    };
    expect(cursor.position.key).toBeDefined();
    cursor.position.key.gsi2pk = `ENV#01ARZ3NDEKTSV4RRFFQ69G5FC0#METRIC#${cursor.position.metric}`;
    expect(
      service.listUsage({
        ...invocation,
        query: { ...window, cursor: await cursorCodec.seal(JSON.stringify(cursor)), limit: 1 },
      }),
    ).rejects.toMatchObject({ code: "invalid_cursor", status: 400 });
  });

  test("lists billing periods by period start though the index orders them by update", async () => {
    const period = (periodStart: string, updatedAt: string) =>
      record(ProviderBillingPeriodRecord, {
        data: {
          createdAt: updatedAt,
          environmentId: ENVIRONMENT_ID,
          estimatedCost: { amountMinor: 5, currency: "USD" },
          organizationId: ORGANIZATION_ID,
          periodEnd: "2026-08-01T00:00:00.000Z",
          periodStart,
          projectId: PROJECT_ID,
          provider: `openai-${periodStart.slice(5, 7)}`,
          status: "closed",
          updatedAt,
          version: 1,
        },
        itemType: "provider-billing-period",
      });
    const service = operationalService(
      database([
        ...fixtureRecords(),
        // Opened in the window, reconciled weeks later.
        period(window.since, "2026-08-20T00:00:00.000Z"),
        // Updated in the window, for an earlier period.
        period("2026-06-25T00:00:00.000Z", "2026-07-25T06:00:00.000Z"),
      ]),
    );
    const page = await service.listSpend({ ...invocation, query: window });

    expect(
      page.items.map(
        (item) => `${item.type}:${stringField(item.data.periodStart ?? item.data.provider)}`,
      ),
    ).toEqual(["provider-billing-period:2026-07-25T00:00:00.000Z", "spend-ledger:openai"]);
  });

  test("pages up to 1,000 records and rejects a larger limit", async () => {
    const service = operationalService(database(fixtureRecords()));
    expect(service.listUsage({ ...invocation, query: { limit: 1_000 } })).resolves.toMatchObject({
      items: [{ type: "usage-counter-shard" }],
    });
    expect(service.listUsage({ ...invocation, query: { limit: 1_001 } })).rejects.toMatchObject({
      code: "invalid_limit",
      status: 400,
    });
  });
});
