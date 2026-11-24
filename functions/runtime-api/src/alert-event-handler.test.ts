import { describe, expect, spyOn, test } from "bun:test";
import {
  MONITOR_SWEEP_SHARD_COUNT,
  SemanticEventData,
  makeAlertDeliveryPersistence,
  makeDynamoDatabase,
  makeIdGenerator,
  makeMonitorPersistence,
  makeSemanticEventRecord,
  tableNamesFromEnvironment,
  withCanonicalRecordKeys,
  type Ulid,
} from "@deployments-ai/db";
import { fakeDynamoDocumentClient } from "@deployments-ai/db/dynamo-testing";
import { monitorEvaluationFailuresMetric } from "./alert-evaluation.ts";
import {
  ALERT_ENV,
  createAlertEventHandler,
  hotPlaneTraceMetrics,
  type AlertRuntimeDependencies,
} from "./alert-event-handler.ts";

const ORG = "01J10000000000000000000001" as Ulid;
const PROJECT = "01J10000000000000000000002" as Ulid;
const ENVIRONMENT = "01J10000000000000000000003" as Ulid;
const OWNER = "01J10000000000000000000004" as Ulid;
const START = "2026-11-02T10:00:00.000Z";

type SemanticEvent = typeof SemanticEventData.Type;

function harness() {
  const fake = fakeDynamoDocumentClient();
  const tables = tableNamesFromEnvironment({});
  for (const record of [
    {
      data: {
        createdAt: START,
        id: ORG,
        name: "Acme",
        slug: "acme",
        status: "active",
        updatedAt: START,
        version: 1,
      },
      itemType: "organization",
    },
    {
      data: {
        createdAt: START,
        id: OWNER,
        kind: "human",
        primaryEmail: "owner@acme.test",
        status: "active",
        updatedAt: START,
        version: 1,
      },
      itemType: "principal",
    },
    {
      data: {
        createdAt: START,
        organizationId: ORG,
        principalId: OWNER,
        role: "owner",
        status: "active",
        updatedAt: START,
        version: 1,
      },
      itemType: "organization-member",
    },
  ]) {
    fake.put(tables.control, withCanonicalRecordKeys(record as never));
  }
  const database = makeDynamoDatabase(fake.client, tables);
  let clock = new Date(START);
  const now = () => clock;
  const ids = makeIdGenerator();
  const monitors = makeMonitorPersistence({ database, generateId: () => ids.generate(), now });
  const sent: { recipient: string; subject: string; text: string }[] = [];
  let failNextSend = false;
  let failNextSentRecord = false;
  const delivery = makeAlertDeliveryPersistence({ database, now });
  const dependencies: AlertRuntimeDependencies = {
    email: {
      delivery: {
        ...delivery,
        claimEmail: async (input) => {
          const claim = await delivery.claimEmail(input);
          if (claim.kind !== "claimed") return claim;
          return {
            kind: "claimed",
            release: async (outcome) => {
              if (outcome === "sent" && failNextSentRecord) {
                failNextSentRecord = false;
                throw new Error("DynamoDB throttled");
              }
              await claim.release(outcome);
            },
          };
        },
      },
      install: { consoleOrigin: "https://console.acme.test", productName: "Acme Agents" },
      monitors,
      send: async (email) => {
        if (failNextSend) {
          failNextSend = false;
          throw new Error("SES throttled");
        }
        sent.push(email);
      },
    },
    evaluation: { monitors, now, observe: {} },
  };
  const handler = createAlertEventHandler(() => dependencies);
  /** Alert events the commit wrote, as EventBridge would deliver them. */
  const alertEvents = () =>
    fake
      .items(tables.events)
      .filter((item) => item.itemType === "semantic-event")
      .map((item) => item.data as SemanticEvent)
      .filter((event) => event.eventType.startsWith("alert."))
      .toSorted((left, right) => left.eventId.localeCompare(right.eventId));
  const deliver = (event: SemanticEvent) =>
    handler({ detail: event, "detail-type": event.eventType, source: "deployments-ai.platform" });
  return {
    dependencies,
    advance: (minutes: number) => {
      clock = new Date(clock.getTime() + minutes * 60_000);
    },
    alertEvents,
    deliver,
    delivery,
    failNextSend: () => {
      failNextSend = true;
    },
    failNextSentRecord: () => {
      failNextSentRecord = true;
    },
    handler,
    monitors,
    sent,
  };
}

function runFailed(at: string) {
  return makeSemanticEventRecord({
    aggregateId: makeIdGenerator().generate(),
    aggregateType: "run",
    aggregateVersion: 2,
    environmentId: ENVIRONMENT,
    eventId: makeIdGenerator().generate(),
    eventType: "run.failed",
    occurredAt: at,
    organizationId: ORG,
    payload: { status: "failed" },
    projectId: PROJECT,
  }).data;
}

describe("alert runtime", () => {
  test("a run failure fires an incident, emails the owner once, and the sweep resolves it", async () => {
    const h = harness();
    await h.monitors.create({
      condition: { kind: "run-failures", threshold: 1, windowMinutes: 15 },
      name: "Checkout failing",
      notify: { emailPrincipalIds: [], emailRoles: ["owner"], webhooks: true },
      organizationId: ORG,
      scope: { environmentId: ENVIRONMENT, kind: "environment", projectId: PROJECT },
    });

    await h.deliver(runFailed(START));
    const [fired] = h.alertEvents();
    expect(fired?.eventType).toBe("alert.fired");

    await h.deliver(fired!);
    await h.deliver(fired!);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toMatchObject({
      recipient: "owner@acme.test",
      subject: "[Firing] Checkout failing",
    });
    expect(h.sent[0]?.text).toContain("https://console.acme.test/o/");

    h.advance(16);
    const sweeps = await Promise.all(
      Array.from({ length: MONITOR_SWEEP_SHARD_COUNT }, (_, shard) =>
        h.handler({ shard, sweep: true }),
      ),
    );
    expect(sweeps.reduce((sum, sweep) => sum + (sweep?.evaluated ?? 0), 0)).toBe(1);
    const resolved = h.alertEvents().at(-1)!;
    expect(resolved.eventType).toBe("alert.resolved");
    await h.deliver(resolved);
    expect(h.sent.map((email) => email.subject)).toEqual([
      "[Firing] Checkout failing",
      "[Resolved] Checkout failing",
    ]);
  });

  test("a failed send is retried on redelivery and then sent exactly once", async () => {
    const h = harness();
    await h.monitors.create({
      condition: { kind: "run-failures", threshold: 1, windowMinutes: 15 },
      name: "Checkout failing",
      notify: { emailPrincipalIds: [], emailRoles: ["owner"], webhooks: false },
      organizationId: ORG,
      scope: { environmentId: ENVIRONMENT, kind: "environment", projectId: PROJECT },
    });
    await h.deliver(runFailed(START));
    const [fired] = h.alertEvents();
    h.failNextSend();
    expect(h.deliver(fired!)).rejects.toThrow("failed to send");
    await Bun.sleep(0);
    await h.deliver(fired!);
    await h.deliver(fired!);
    expect(h.sent).toHaveLength(1);
  });

  test("a sender that died between claim and send is covered by Lambda's next async retry", async () => {
    const h = harness();
    await h.monitors.create({
      condition: { kind: "run-failures", threshold: 1, windowMinutes: 15 },
      name: "Checkout failing",
      notify: { emailPrincipalIds: [], emailRoles: ["owner"], webhooks: false },
      organizationId: ORG,
      scope: { environmentId: ENVIRONMENT, kind: "environment", projectId: PROJECT },
    });
    await h.deliver(runFailed(START));
    const [fired] = h.alertEvents();
    const crashed = await h.delivery.claimEmail({
      eventId: fired!.eventId as Ulid,
      organizationId: ORG,
      principalId: OWNER,
    });
    expect(crashed.kind).toBe("claimed");

    expect(h.deliver(fired!)).rejects.toThrow("failed to send");
    await Bun.sleep(0);
    expect(h.sent).toHaveLength(0);
    h.advance(1);
    await h.deliver(fired!);
    await h.deliver(fired!);
    expect(h.sent).toHaveLength(1);
  });

  test("an email that went out is not resent when recording it fails", async () => {
    const h = harness();
    await h.monitors.create({
      condition: { kind: "run-failures", threshold: 1, windowMinutes: 15 },
      name: "Checkout failing",
      notify: { emailPrincipalIds: [], emailRoles: ["owner"], webhooks: false },
      organizationId: ORG,
      scope: { environmentId: ENVIRONMENT, kind: "environment", projectId: PROJECT },
    });
    await h.deliver(runFailed(START));
    const [fired] = h.alertEvents();
    h.failNextSentRecord();
    await h.deliver(fired!);
    expect(h.sent).toHaveLength(1);
  });

  test("a test send emails only the member who asked", async () => {
    const h = harness();
    const monitor = await h.monitors.create({
      condition: { kind: "approval-wait", waitMinutes: 30 },
      name: "Approvals stuck",
      notify: { emailPrincipalIds: [], emailRoles: ["admin"], webhooks: false },
      organizationId: ORG,
      scope: { environmentId: ENVIRONMENT, kind: "environment", projectId: PROJECT },
    });
    await h.monitors.sendTest({
      monitorId: monitor.data.id,
      organizationId: ORG,
      requestedByPrincipalId: OWNER,
    });
    await h.deliver(h.alertEvents()[0]!);
    expect(h.sent).toMatchObject([
      { recipient: "owner@acme.test", subject: "[Test] Approvals stuck" },
    ]);
  });

  test("ignores events from other sources and events no monitor listens for", async () => {
    const h = harness();
    await h.handler({ detail: runFailed(START), source: "aws.events" });
    await h.handler({
      detail: { ...runFailed(START), eventType: "run.completed" },
      source: "deployments-ai.platform",
    });
    expect(h.alertEvents()).toEqual([]);
  });
});

describe("hot-plane trace metrics", () => {
  const env = {
    [ALERT_ENV.observabilityBaseUrl]: "http://hot-plane.internal/",
    [ALERT_ENV.observabilitySecretArn]: "arn:aws:ssm:us-east-2:123456789012:parameter/hot-plane",
  };
  const window = {
    environmentId: ENVIRONMENT,
    from: new Date("2026-11-02T09:00:00.000Z"),
    organizationId: ORG,
    projectId: PROJECT,
    to: new Date(START),
  };

  test("asks for one deployment's series instead of the top groups", async () => {
    const requests: URL[] = [];
    const read = hotPlaneTraceMetrics(
      env,
      async () => JSON.stringify({ serviceToken: "secret" }),
      async (url) => {
        requests.push(new URL(String(url)));
        return Response.json({ items: [{ error_count: 1, trace_count: 4 }] });
      },
    );
    expect(await read({ ...window, agentDeploymentId: "deployment-21" })).toEqual([
      { error_count: 1, trace_count: 4 },
    ]);
    expect(requests[0]?.searchParams.get("agentDeploymentId")).toBe("deployment-21");
    expect(requests[0]?.searchParams.has("groupBy")).toBe(false);
  });

  test("loads the credential again after a rejected load", async () => {
    let loads = 0;
    const read = hotPlaneTraceMetrics(
      env,
      async () => {
        loads += 1;
        if (loads === 1) throw new Error("ThrottlingException");
        return "secret";
      },
      async () => Response.json({ items: [] }),
    );
    expect(read(window)).rejects.toThrow("ThrottlingException");
    await Bun.sleep(0);
    expect(await read(window)).toEqual([]);
    expect(loads).toBe(2);
  });
});

describe("monitor sweep", () => {
  const SHARD = 3;

  /** A shard of `count` monitors in pages of 100, with the evaluation's reads observable. */
  function shardOf(count: number, options: { readonly failEvery?: number } = {}) {
    const h = harness();
    const pages: number[] = [];
    let inFlight = 0;
    let mostInFlight = 0;
    let reads = 0;
    const monitors = {
      ...h.monitors,
      snapshot: async (organizationId: Ulid, monitorId: Ulid) => {
        reads += 1;
        const read = reads;
        inFlight += 1;
        mostInFlight = Math.max(mostInFlight, inFlight);
        await Bun.sleep(1);
        inFlight -= 1;
        if (options.failEvery && read % options.failEvery === 0) throw new Error("throttled");
        return h.monitors.snapshot(organizationId, monitorId);
      },
      sweepPage: async ({
        cursor,
        shard,
      }: {
        cursor?: Readonly<Record<string, unknown>>;
        shard: number;
      }) => {
        expect(shard).toBe(SHARD);
        const page = cursor ? Number(cursor.page) : 0;
        pages.push(page);
        const start = page * 100;
        return {
          monitors: Array.from({ length: Math.max(0, Math.min(100, count - start)) }, () => ({
            monitorId: makeIdGenerator().generate() as Ulid,
            organizationId: ORG,
          })),
          ...(start + 100 < count ? { cursor: { page: page + 1 } } : {}),
        };
      },
    };
    const handler = createAlertEventHandler(() => ({
      ...h.dependencies,
      evaluation: { ...h.dependencies.evaluation, monitors },
    }));
    return { handler, mostInFlight: () => mostInFlight, pages, reads: () => reads };
  }

  test("one shard's invocation evaluates every monitor of the shard, with no install-wide cap", async () => {
    const shard = shardOf(2_500);
    expect(
      await shard.handler(
        { shard: SHARD, sweep: true },
        { getRemainingTimeInMillis: () => 300_000 },
      ),
    ).toEqual({ evaluated: 2_500, failed: 0, shard: SHARD, truncated: false });
  });

  test("evaluates a bounded number of monitors at a time", async () => {
    const shard = shardOf(100);
    await shard.handler({ shard: SHARD, sweep: true }, { getRemainingTimeInMillis: () => 300_000 });
    expect(shard.mostInFlight()).toBe(8);
  });

  test("stops starting evaluations before the Lambda deadline", async () => {
    const shard = shardOf(1_000);
    let remaining = 300_000;
    const result = await shard.handler(
      { shard: SHARD, sweep: true },
      {
        getRemainingTimeInMillis: () => {
          remaining -= 1_000;
          return remaining;
        },
      },
    );
    expect(result).toMatchObject({ shard: SHARD, truncated: true });
    expect(result?.evaluated).toBeLessThan(300);
    expect(shard.pages.length).toBeLessThan(4);
  });

  test("reports monitors it could not evaluate as a metric the error alarm reads", async () => {
    const shard = shardOf(10, { failEvery: 5 });
    const log = spyOn(console, "log").mockImplementation(() => {});
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(
        await shard.handler(
          { shard: SHARD, sweep: true },
          { getRemainingTimeInMillis: () => 300_000 },
        ),
      ).toMatchObject({ evaluated: 8, failed: 2 });
      expect(log.mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual([
        { ...JSON.parse(monitorEvaluationFailuresMetric(2, 0)), _aws: expect.any(Object) },
      ]);
    } finally {
      log.mockRestore();
      errors.mockRestore();
    }
  });
});
