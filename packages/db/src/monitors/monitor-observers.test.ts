import { describe, expect, test } from "bun:test";
import { DEFAULT_TABLE_NAMES } from "../client-types.ts";
import { withCanonicalRecordKeys } from "../records/index.ts";
import type { MonitorCondition } from "../records/monitors.ts";
import { evaluateMonitor, evaluateMonitorsForEvent } from "./evaluation.ts";
import {
  DEPLOYMENT_ID,
  ENVIRONMENT_ID,
  ENVIRONMENT_SCOPE,
  ORGANIZATION_ID,
  OWNERS_BY_EMAIL,
  PROJECT_ID,
  monitorHarness,
  semanticEvent,
  testUlid,
} from "./monitor-test-support.ts";
import { monitorObservers, type TraceMetricBucket } from "./observers.ts";

type Harness = ReturnType<typeof monitorHarness>;

function withObservers(harness: Harness, buckets?: readonly TraceMetricBucket[]) {
  Object.assign(
    harness.observers,
    monitorObservers({ database: harness.database, traceMetrics: async () => buckets }),
  );
}

async function monitorFor(harness: Harness, condition: MonitorCondition) {
  return harness.monitors.create({
    condition,
    name: condition.kind,
    notify: OWNERS_BY_EMAIL,
    organizationId: ORGANIZATION_ID,
    scope: ENVIRONMENT_SCOPE,
  });
}

function seedApproval(harness: Harness, createdAt: string, status = "pending") {
  const id = testUlid();
  harness.fake.put(
    DEFAULT_TABLE_NAMES.execution,
    withCanonicalRecordKeys({
      data: {
        createdAt,
        environmentId: ENVIRONMENT_ID,
        escalationCount: 0,
        id,
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
        request: {},
        requestedByAgentDeploymentId: DEPLOYMENT_ID,
        runId: testUlid(),
        status,
        threadId: testUlid(),
        updatedAt: createdAt,
        version: 1,
      },
      itemType: "approval",
    }),
  );
  return id;
}

function seedEndpoint(
  harness: Harness,
  fields: {
    readonly consecutiveFailures?: number;
    readonly status: string;
    readonly disabledReason?: string;
  },
) {
  const at = harness.now().toISOString();
  harness.fake.put(
    DEFAULT_TABLE_NAMES.control,
    withCanonicalRecordKeys({
      data: {
        createdAt: at,
        environmentId: ENVIRONMENT_ID,
        eventTypes: ["run.failed"],
        id: testUlid(),
        name: "Orders hook",
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
        signingSecretRef: { credentialId: testUlid(), generation: 0, store: "dynamodb-kms" },
        updatedAt: at,
        url: "https://hooks.example.com/orders",
        version: 1,
        ...fields,
      },
      itemType: "webhook-endpoint",
    }),
  );
}

const kinds = (harness: Harness) => harness.alertEvents().map((event) => event.eventType);

describe("current-state and metric monitors", () => {
  test("approval wait fires once an approval has waited past the threshold and resolves when none do", async () => {
    const harness = monitorHarness();
    withObservers(harness);
    const monitor = await monitorFor(harness, { kind: "approval-wait", waitMinutes: 30 });
    const target = { monitorId: monitor.data.id, organizationId: ORGANIZATION_ID };

    seedApproval(harness, harness.now().toISOString());
    seedApproval(harness, "2026-11-02T08:00:00.000Z", "approved");
    await evaluateMonitorsForEvent(
      harness.dependencies,
      semanticEvent("approval.requested", { occurredAt: harness.now().toISOString() }),
    );
    expect(kinds(harness)).toEqual([]);

    harness.advance(31);
    await evaluateMonitor(harness.dependencies, target);
    expect(kinds(harness)).toEqual(["alert.fired"]);
    expect(harness.alertEvents()[0]?.payload.summary).toBe(
      "1 approval waiting longer than 30 minutes; the oldest has waited 31 minutes.",
    );

    for (const item of harness.fake.items(DEFAULT_TABLE_NAMES.execution)) {
      if (item.itemType === "approval") {
        harness.fake.delete(DEFAULT_TABLE_NAMES.execution, {
          pk: item.pk as string,
          sk: item.sk as string,
        });
      }
    }
    await evaluateMonitor(harness.dependencies, target);
    expect(kinds(harness)).toEqual(["alert.fired", "alert.resolved"]);
  });

  test("webhook endpoint health fires on an endpoint disabled by failures, not one disabled by hand", async () => {
    const harness = monitorHarness();
    withObservers(harness);
    const monitor = await monitorFor(harness, { kind: "webhook-endpoint-health" });
    const target = { monitorId: monitor.data.id, organizationId: ORGANIZATION_ID };

    seedEndpoint(harness, { disabledReason: "manual", status: "disabled" });
    seedEndpoint(harness, { consecutiveFailures: 4, status: "active" });
    await evaluateMonitor(harness.dependencies, target);
    expect(kinds(harness)).toEqual([]);

    seedEndpoint(harness, { disabledReason: "consecutive-failures", status: "disabled" });
    await evaluateMonitorsForEvent(
      harness.dependencies,
      semanticEvent("webhook.endpoint.disabled", { occurredAt: harness.now().toISOString() }),
    );
    expect(kinds(harness)).toEqual(["alert.fired"]);
    expect(harness.alertEvents()[0]?.payload.summary).toBe(
      "1 webhook endpoint failing: Orders hook.",
    );
  });

  test("webhook endpoint health can fire on consecutive failed deliveries before the endpoint is disabled", async () => {
    const harness = monitorHarness();
    withObservers(harness);
    const monitor = await monitorFor(harness, {
      consecutiveFailures: 3,
      kind: "webhook-endpoint-health",
    });
    seedEndpoint(harness, { consecutiveFailures: 3, status: "active" });
    await evaluateMonitor(harness.dependencies, {
      monitorId: monitor.data.id,
      organizationId: ORGANIZATION_ID,
    });
    expect(kinds(harness)).toEqual(["alert.fired"]);
  });

  test("trace error rate fires above the threshold only with enough traces", async () => {
    const quiet = monitorHarness();
    withObservers(quiet, [{ error_count: 3, trace_count: 4 }]);
    const low = await monitorFor(quiet, {
      kind: "trace-error-rate",
      minimumTraces: 10,
      thresholdPercent: 20,
      windowHours: 1,
    });
    await evaluateMonitor(quiet.dependencies, {
      monitorId: low.data.id,
      organizationId: ORGANIZATION_ID,
    });
    expect(kinds(quiet)).toEqual([]);

    const harness = monitorHarness();
    withObservers(harness, [
      { error_count: 2, trace_count: 10 },
      { error_count: 3, trace_count: 10 },
    ]);
    const monitor = await monitorFor(harness, {
      kind: "trace-error-rate",
      minimumTraces: 10,
      thresholdPercent: 20,
      windowHours: 2,
    });
    await evaluateMonitor(harness.dependencies, {
      monitorId: monitor.data.id,
      organizationId: ORGANIZATION_ID,
    });
    expect(harness.alertEvents()[0]?.payload.summary).toBe(
      "25.0% of 20 traces failed in the last 2 hours (threshold 20%).",
    );
  });

  test("trace latency fires on the slowest hour's p95", async () => {
    const harness = monitorHarness();
    withObservers(harness, [
      { error_count: 0, p95_duration_ms: 900, trace_count: 5 },
      { error_count: 0, p95_duration_ms: 12_500, trace_count: 5 },
    ]);
    const monitor = await monitorFor(harness, {
      kind: "trace-latency",
      minimumTraces: 5,
      p95Milliseconds: 10_000,
      windowHours: 2,
    });
    await evaluateMonitor(harness.dependencies, {
      monitorId: monitor.data.id,
      organizationId: ORGANIZATION_ID,
    });
    expect(harness.alertEvents()[0]?.payload.summary).toBe(
      "p95 trace duration reached 12,500 ms in the last 2 hours (threshold 10,000 ms).",
    );
  });

  test("metric monitors stay quiet when the install has no observability service", async () => {
    const harness = monitorHarness();
    withObservers(harness, undefined);
    const monitor = await monitorFor(harness, {
      kind: "trace-error-rate",
      minimumTraces: 1,
      thresholdPercent: 1,
      windowHours: 1,
    });
    await evaluateMonitor(harness.dependencies, {
      monitorId: monitor.data.id,
      organizationId: ORGANIZATION_ID,
    });
    expect(kinds(harness)).toEqual([]);
  });
});
