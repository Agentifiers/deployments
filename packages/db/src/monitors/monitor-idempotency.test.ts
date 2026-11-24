import { describe, expect, test } from "bun:test";
import { evaluateMonitor, evaluateMonitorsForEvent } from "./evaluation.ts";
import { transactionCanceledError } from "../testing/dynamo-document-client.fixture.ts";
import { makeAlertHistory } from "./history.ts";
import {
  ENVIRONMENT_SCOPE,
  ORGANIZATION_ID,
  OWNERS_BY_EMAIL,
  monitorHarness,
  semanticEvent,
  testUlid,
} from "./monitor-test-support.ts";

async function runFailuresMonitor(harness: ReturnType<typeof monitorHarness>, threshold = 1) {
  return harness.monitors.create({
    condition: { kind: "run-failures", threshold, windowMinutes: 15 },
    name: "Runs failing",
    notify: OWNERS_BY_EMAIL,
    organizationId: ORGANIZATION_ID,
    scope: ENVIRONMENT_SCOPE,
  });
}

describe("monitor evaluation under retries and concurrency", () => {
  test("concurrent evaluators of one firing condition open one incident and send one alert", async () => {
    const harness = monitorHarness();
    const monitor = await runFailuresMonitor(harness);
    const failed = semanticEvent("run.failed", { occurredAt: harness.now().toISOString() });
    await harness.monitors.recordSignal({
      activeUntil: new Date(harness.now().getTime() + 3_600_000).toISOString(),
      eventId: failed.eventId as never,
      eventType: failed.eventType,
      monitor,
      occurredAt: failed.occurredAt,
    });

    const target = { monitorId: monitor.data.id, organizationId: ORGANIZATION_ID };
    const results = await Promise.all([
      evaluateMonitor(harness.dependencies, target),
      evaluateMonitor(harness.dependencies, target),
      evaluateMonitor(harness.dependencies, target),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(harness.incidents()).toHaveLength(1);
    expect(harness.alertEvents().map((event) => event.eventType)).toEqual(["alert.fired"]);
  });

  test("concurrent deliveries of different events converge on one incident", async () => {
    const harness = monitorHarness();
    await runFailuresMonitor(harness);
    await Promise.all(
      [1, 2, 3, 4].map(() =>
        evaluateMonitorsForEvent(
          harness.dependencies,
          semanticEvent("run.failed", { occurredAt: harness.now().toISOString() }),
        ),
      ),
    );
    expect(harness.incidents()).toHaveLength(1);
    expect(harness.alertEvents().map((event) => event.eventType)).toEqual(["alert.fired"]);
  });

  test("a commit that failed is retried from a fresh read and lands once", async () => {
    const harness = monitorHarness();
    await runFailuresMonitor(harness);
    const event = semanticEvent("run.failed", { occurredAt: harness.now().toISOString() });
    harness.fake.failNextTransaction(
      (input) =>
        input.TransactItems?.some((item) => item.Put?.Item?.["itemType"] === "monitor-incident") ===
        true,
      () => new Error("Lambda timed out"),
    );

    const interrupted = await evaluateMonitorsForEvent(harness.dependencies, event).then(
      () => undefined,
      (cause: unknown) => cause,
    );
    expect(interrupted).toBeInstanceOf(Error);
    expect(harness.incidents()).toEqual([]);

    await evaluateMonitorsForEvent(harness.dependencies, event);
    await evaluateMonitorsForEvent(harness.dependencies, event);
    expect(harness.incidents()).toHaveLength(1);
    expect(harness.alertEvents().map((event) => event.eventType)).toEqual(["alert.fired"]);
  });

  test("a lost version race re-decides instead of overwriting", async () => {
    const harness = monitorHarness();
    await runFailuresMonitor(harness);
    harness.fake.failNextTransaction(
      (input) =>
        input.TransactItems?.some((item) => item.Put?.Item?.["itemType"] === "monitor-incident") ===
        true,
      () => transactionCanceledError(["None", "ConditionalCheckFailed"]),
    );
    await evaluateMonitorsForEvent(
      harness.dependencies,
      semanticEvent("run.failed", { occurredAt: harness.now().toISOString() }),
    );
    expect(harness.incidents()).toHaveLength(1);
    expect(harness.alertEvents().map((event) => event.eventType)).toEqual(["alert.fired"]);
  });

  test("a resolved incident and a new firing make a second incident with its own history", async () => {
    const harness = monitorHarness();
    const monitor = await runFailuresMonitor(harness);
    const fail = () =>
      evaluateMonitorsForEvent(
        harness.dependencies,
        semanticEvent("run.failed", { occurredAt: harness.now().toISOString() }),
      );
    await fail();
    harness.advance(20);
    await evaluateMonitor(harness.dependencies, {
      monitorId: monitor.data.id,
      organizationId: ORGANIZATION_ID,
    });
    await fail();

    const history = makeAlertHistory({ database: harness.database, now: harness.now });
    const page = await history.listIncidents({ limit: 20, organizationId: ORGANIZATION_ID });
    expect(page.items.map((incident) => incident.data.status)).toEqual(["firing", "resolved"]);
    const resolved = page.items[1]!;
    const detail = await history.getIncident(ORGANIZATION_ID, monitor.data.id, resolved.data.id);
    expect(detail.data.timeline.map((entry) => entry.type)).toEqual(["fired", "resolved"]);
  });

  test("archiving a firing monitor resolves its incident silently, with no evaluation after", async () => {
    const harness = monitorHarness();
    const monitor = await runFailuresMonitor(harness);
    await evaluateMonitorsForEvent(
      harness.dependencies,
      semanticEvent("run.failed", { occurredAt: harness.now().toISOString() }),
    );
    await harness.monitors.archive(ORGANIZATION_ID, monitor.data.id);
    await harness.monitors.archive(ORGANIZATION_ID, monitor.data.id);
    expect(harness.incidents()).toMatchObject([
      { resolution: "monitor-archived", status: "resolved" },
    ]);
    expect(harness.alertEvents()).toMatchObject([
      { eventType: "alert.fired" },
      { eventType: "alert.resolved", payload: { deliverEmail: false, deliverWebhooks: false } },
    ]);
    expect((await harness.monitors.get(ORGANIZATION_ID, monitor.data.id)).data.status).toBe(
      "archived",
    );
  });

  test("an archive that lost its race re-reads and still resolves the incident once", async () => {
    const harness = monitorHarness();
    const monitor = await runFailuresMonitor(harness);
    await evaluateMonitorsForEvent(
      harness.dependencies,
      semanticEvent("run.failed", { occurredAt: harness.now().toISOString() }),
    );
    harness.fake.failNextTransaction(
      (input) =>
        input.TransactItems?.some((item) => item.Put?.Item?.["itemType"] === "monitor-incident") ===
        true,
      () => transactionCanceledError(["ConditionalCheckFailed", "None", "None"]),
    );
    await harness.monitors.archive(ORGANIZATION_ID, monitor.data.id);
    expect(harness.incidents()).toMatchObject([{ status: "resolved" }]);
    expect(harness.alertEvents().map((event) => event.eventType)).toEqual([
      "alert.fired",
      "alert.resolved",
    ]);
  });

  test("an evaluation that read the monitor before it was archived cannot open an incident", async () => {
    const harness = monitorHarness();
    const monitor = await runFailuresMonitor(harness);
    const failed = semanticEvent("run.failed", { occurredAt: harness.now().toISOString() });
    await harness.monitors.recordSignal({
      activeUntil: new Date(harness.now().getTime() + 3_600_000).toISOString(),
      eventId: failed.eventId as never,
      eventType: failed.eventType,
      monitor,
      occurredAt: failed.occurredAt,
    });
    const target = { monitorId: monitor.data.id, organizationId: ORGANIZATION_ID };
    let archived = false;
    const racing = {
      ...harness.dependencies,
      monitors: {
        ...harness.monitors,
        countSignals: async (...input: Parameters<typeof harness.monitors.countSignals>) => {
          if (!archived) {
            archived = true;
            await harness.monitors.archive(ORGANIZATION_ID, monitor.data.id);
          }
          return harness.monitors.countSignals(...input);
        },
      },
    };
    await evaluateMonitor(racing, target);
    expect(harness.incidents()).toEqual([]);
    expect(harness.alertEvents()).toEqual([]);
  });

  test("member notification preferences round-trip", async () => {
    const harness = monitorHarness();
    const history = makeAlertHistory({ database: harness.database, now: harness.now });
    const principalId = testUlid();
    expect(await history.preference(ORGANIZATION_ID, principalId)).toBeUndefined();
    const mutedMonitorId = testUlid();
    await history.putPreference({
      email: "all",
      mutedMonitorIds: [mutedMonitorId],
      organizationId: ORGANIZATION_ID,
      principalId,
    });
    await history.putPreference({
      email: "none",
      mutedMonitorIds: [mutedMonitorId],
      organizationId: ORGANIZATION_ID,
      principalId,
    });
    expect((await history.preference(ORGANIZATION_ID, principalId))?.data).toMatchObject({
      email: "none",
      mutedMonitorIds: [mutedMonitorId],
    });
  });
});
