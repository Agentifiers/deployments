import { describe, expect, test } from "bun:test";
import { evaluateMonitor, evaluateMonitorsForEvent } from "./evaluation.ts";
import { MAX_MONITORS_PER_ORGANIZATION } from "./persistence.ts";
import {
  DEPLOYMENT_ID,
  ENVIRONMENT_SCOPE,
  ORGANIZATION_ID,
  OTHER_ENVIRONMENT_ID,
  OWNERS_BY_EMAIL,
  monitorHarness,
  semanticEvent,
  testUlid,
} from "./monitor-test-support.ts";

const target = (monitorId: string) => ({
  monitorId: monitorId as never,
  organizationId: ORGANIZATION_ID,
});

describe("event-driven monitor evaluation", () => {
  test("run failures fire once at the threshold and resolve when the window empties", async () => {
    const harness = monitorHarness();
    const monitor = await harness.monitors.create({
      condition: { kind: "run-failures", threshold: 3, windowMinutes: 15 },
      name: "Runs failing",
      notify: OWNERS_BY_EMAIL,
      organizationId: ORGANIZATION_ID,
      scope: ENVIRONMENT_SCOPE,
    });
    const fail = () =>
      evaluateMonitorsForEvent(
        harness.dependencies,
        semanticEvent("run.failed", { occurredAt: harness.now().toISOString() }),
      );

    await fail();
    await fail();
    expect(harness.alertEvents()).toEqual([]);
    await fail();
    await fail();
    await fail();

    const fired = harness.alertEvents();
    expect(fired.map((event) => event.eventType)).toEqual(["alert.fired"]);
    expect(fired[0]?.payload).toMatchObject({
      deliverEmail: true,
      deliverWebhooks: true,
      monitorId: monitor.data.id,
      summary: "3 failed runs in the last 15 minutes (threshold 3).",
    });

    harness.advance(16);
    await evaluateMonitor(harness.dependencies, target(monitor.data.id));
    expect(harness.alertEvents().map((event) => event.eventType)).toEqual([
      "alert.fired",
      "alert.resolved",
    ]);
    expect(harness.incidents()).toMatchObject([{ status: "resolved" }]);
  });

  test("a redelivered event is counted once", async () => {
    const harness = monitorHarness();
    await harness.monitors.create({
      condition: { kind: "run-failures", threshold: 2, windowMinutes: 15 },
      name: "Runs failing",
      notify: OWNERS_BY_EMAIL,
      organizationId: ORGANIZATION_ID,
      scope: ENVIRONMENT_SCOPE,
    });
    const event = semanticEvent("run.failed", { occurredAt: harness.now().toISOString() });
    await evaluateMonitorsForEvent(harness.dependencies, event);
    await evaluateMonitorsForEvent(harness.dependencies, event);
    expect(harness.alertEvents()).toEqual([]);
  });

  test("filters by deployment, tool, schedule, and environment", async () => {
    const harness = monitorHarness();
    const create = (condition: Parameters<typeof harness.monitors.create>[0]["condition"]) =>
      harness.monitors.create({
        condition,
        name: condition.kind,
        notify: OWNERS_BY_EMAIL,
        organizationId: ORGANIZATION_ID,
        scope: ENVIRONMENT_SCOPE,
      });
    const scheduleId = testUlid();
    const runs = await create({
      agentDeploymentId: DEPLOYMENT_ID,
      kind: "run-failures",
      threshold: 1,
      windowMinutes: 15,
    });
    const tools = await create({
      kind: "tool-failures",
      threshold: 1,
      toolName: "send_invoice",
      windowMinutes: 15,
    });
    const schedules = await create({
      kind: "schedule-problems",
      scheduleId,
      threshold: 1,
      windowMinutes: 60,
    });
    const at = harness.now().toISOString();
    for (const event of [
      semanticEvent("run.failed", { occurredAt: at, payload: { agentDeploymentId: testUlid() } }),
      semanticEvent("run.failed", {
        environmentId: OTHER_ENVIRONMENT_ID,
        occurredAt: at,
        payload: { agentDeploymentId: DEPLOYMENT_ID },
      }),
      semanticEvent("tool-call.failed", { occurredAt: at, payload: { toolName: "lookup" } }),
      semanticEvent("schedule.skipped", { occurredAt: at, payload: { scheduleId: testUlid() } }),
    ]) {
      await evaluateMonitorsForEvent(harness.dependencies, event);
    }
    expect(harness.alertEvents()).toEqual([]);

    for (const event of [
      semanticEvent("run.failed", {
        occurredAt: at,
        payload: { agentDeploymentId: DEPLOYMENT_ID },
      }),
      semanticEvent("tool-call.failed", { occurredAt: at, payload: { toolName: "send_invoice" } }),
      semanticEvent("schedule.expired", {
        aggregateId: scheduleId,
        aggregateType: "schedule",
        occurredAt: at,
      }),
    ]) {
      await evaluateMonitorsForEvent(harness.dependencies, event);
    }
    expect(
      harness
        .alertEvents()
        .map((event) => JSON.stringify(event.payload.monitorId))
        .toSorted((left, right) => left.localeCompare(right)),
    ).toEqual(
      [runs.data.id, tools.data.id, schedules.data.id]
        .map((id) => JSON.stringify(id))
        .toSorted((left, right) => left.localeCompare(right)),
    );
  });

  test("a budget crossing opens one incident per period, re-notifies on a higher threshold, and expires at period end", async () => {
    const harness = monitorHarness("2026-11-10T00:00:00.000Z");
    const crossing = (threshold: number) =>
      semanticEvent("budget.threshold-crossed", {
        aggregateType: "budget-period",
        environmentId: undefined,
        occurredAt: harness.now().toISOString(),
        payload: {
          amountUsdMicros: 100_000_000,
          budgetId: "01K00000000000000000000BG1",
          budgetName: "Production",
          periodEnd: "2026-12-01T00:00:00.000Z",
          spendUsdMicros: threshold * 1_000_000,
          threshold,
        },
        projectId: undefined,
      });

    const fifty = crossing(50);
    await evaluateMonitorsForEvent(harness.dependencies, fifty);
    await evaluateMonitorsForEvent(harness.dependencies, fifty);
    const monitors = await harness.monitors.list(ORGANIZATION_ID);
    expect(monitors.map((monitor) => monitor.data.name).toSorted()).toEqual([
      "Budget alerts",
      "Included model spend exhausted",
    ]);
    expect(harness.alertEvents().map((event) => event.eventType)).toEqual(["alert.fired"]);
    expect(harness.alertEvents()[0]?.payload.summary).toBe(
      "Budget Production reached 50%: $50.00 of $100.00.",
    );

    await evaluateMonitorsForEvent(harness.dependencies, crossing(80));
    expect(harness.alertEvents().map((event) => event.eventType)).toEqual([
      "alert.fired",
      "alert.renotified",
    ]);

    const budgetMonitor = monitors.find((monitor) => monitor.data.name === "Budget alerts")!;
    harness.advance(60 * 24 * 22);
    await evaluateMonitor(harness.dependencies, target(budgetMonitor.data.id));
    expect(harness.alertEvents().at(-1)?.eventType).toBe("alert.resolved");
  });

  test("a muted monitor records the incident but tells nobody", async () => {
    const harness = monitorHarness();
    const monitor = await harness.monitors.create({
      condition: { kind: "run-failures", threshold: 1, windowMinutes: 15 },
      name: "Runs failing",
      notify: OWNERS_BY_EMAIL,
      organizationId: ORGANIZATION_ID,
      scope: ENVIRONMENT_SCOPE,
    });
    await harness.monitors.update({
      monitorId: monitor.data.id,
      mute: {},
      organizationId: ORGANIZATION_ID,
    });
    await evaluateMonitorsForEvent(
      harness.dependencies,
      semanticEvent("run.failed", { occurredAt: harness.now().toISOString() }),
    );
    expect(harness.alertEvents()).toMatchObject([
      { eventType: "alert.fired", payload: { deliverEmail: false, deliverWebhooks: false } },
    ]);
    expect(harness.incidents()).toMatchObject([
      { status: "firing", timeline: [{ notified: false, type: "fired" }] },
    ]);
  });

  test("one monitor that fails to evaluate neither drops nor skips the monitors after it", async () => {
    const harness = monitorHarness();
    const create = (name: string) =>
      harness.monitors.create({
        condition: { kind: "run-failures", threshold: 1, windowMinutes: 15 },
        name,
        notify: OWNERS_BY_EMAIL,
        organizationId: ORGANIZATION_ID,
        scope: ENVIRONMENT_SCOPE,
      });
    const first = await create("First");
    const second = await create("Second");
    harness.fake.failNextTransaction(
      (input) =>
        input.TransactItems?.some(
          (item) =>
            item.Put?.Item?.["itemType"] === "monitor-incident" &&
            (item.Put.Item["data"] as { monitorId?: string }).monitorId === first.data.id,
        ) === true,
      () => new Error("DynamoDB throttled"),
    );
    const event = semanticEvent("run.failed", { occurredAt: harness.now().toISOString() });

    expect(evaluateMonitorsForEvent(harness.dependencies, event)).rejects.toThrow(
      "DynamoDB transact-write failed",
    );
    await Bun.sleep(0);
    expect(harness.alertEvents().map((alert) => alert.payload.monitorId)).toEqual([second.data.id]);

    await evaluateMonitorsForEvent(harness.dependencies, event);
    expect(harness.alertEvents().map((alert) => alert.payload.monitorId)).toEqual(
      expect.arrayContaining([first.data.id, second.data.id]),
    );
    expect(harness.alertEvents()).toHaveLength(2);
  });

  test("an event does not recount a firing window unless a repeat notification is due", async () => {
    const harness = monitorHarness();
    const counted: string[] = [];
    const dependencies = {
      ...harness.dependencies,
      monitors: {
        ...harness.monitors,
        countSignals: (...input: Parameters<typeof harness.monitors.countSignals>) => {
          counted.push(input[0].data.name);
          return harness.monitors.countSignals(...input);
        },
      },
    };
    await harness.monitors.create({
      condition: { kind: "run-failures", threshold: 1, windowMinutes: 15 },
      name: "Once",
      notify: OWNERS_BY_EMAIL,
      organizationId: ORGANIZATION_ID,
      scope: ENVIRONMENT_SCOPE,
    });
    await harness.monitors.create({
      condition: { kind: "run-failures", threshold: 1, windowMinutes: 15 },
      name: "Repeating",
      notify: OWNERS_BY_EMAIL,
      organizationId: ORGANIZATION_ID,
      renotifyMinutes: 15,
      scope: ENVIRONMENT_SCOPE,
    });
    const fail = () =>
      evaluateMonitorsForEvent(
        dependencies,
        semanticEvent("run.failed", { occurredAt: harness.now().toISOString() }),
      );
    await fail();
    expect(counted).toEqual(["Once", "Repeating"]);

    counted.length = 0;
    harness.advance(5);
    await fail();
    expect(counted).toEqual([]);

    harness.advance(11);
    await fail();
    expect(counted).toEqual(["Repeating"]);
    expect(harness.alertEvents().map((alert) => alert.eventType)).toEqual([
      "alert.fired",
      "alert.fired",
      "alert.renotified",
    ]);
  });

  test("an organization at the monitor limit still gets its default spend monitors", async () => {
    const harness = monitorHarness("2026-11-10T00:00:00.000Z");
    for (let index = 0; index < MAX_MONITORS_PER_ORGANIZATION; index += 1) {
      await harness.monitors.create({
        condition: { kind: "run-failures", threshold: 1, windowMinutes: 15 },
        name: `Monitor ${index}`,
        notify: OWNERS_BY_EMAIL,
        organizationId: ORGANIZATION_ID,
        scope: ENVIRONMENT_SCOPE,
      });
    }
    expect(
      harness.monitors.create({
        condition: { kind: "run-failures", threshold: 1, windowMinutes: 15 },
        name: "One too many",
        notify: OWNERS_BY_EMAIL,
        organizationId: ORGANIZATION_ID,
        scope: ENVIRONMENT_SCOPE,
      }),
    ).rejects.toMatchObject({ code: "monitor_limit_exceeded" });

    await evaluateMonitorsForEvent(
      harness.dependencies,
      semanticEvent("budget.threshold-crossed", {
        aggregateType: "budget-period",
        environmentId: undefined,
        occurredAt: harness.now().toISOString(),
        payload: {
          amountUsdMicros: 100_000_000,
          budgetId: "01K00000000000000000000BG1",
          budgetName: "Production",
          periodEnd: "2026-12-01T00:00:00.000Z",
          spendUsdMicros: 50_000_000,
          threshold: 50,
        },
        projectId: undefined,
      }),
    );
    expect(harness.alertEvents().map((alert) => alert.payload.monitorName)).toEqual([
      "Budget alerts",
    ]);
  });
});
