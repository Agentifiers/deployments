import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { withCanonicalRecordKeys } from "../records/index.ts";
import { MonitorRecord, MonitorStateRecord } from "../records/monitors.ts";
import { decideMonitorTransition, type MonitorObservation } from "./state-machine.ts";
import { ENVIRONMENT_ID, ORGANIZATION_ID, PROJECT_ID, testUlid } from "./monitor-test-support.ts";

const NOW = new Date("2026-11-02T10:00:00.000Z");
const MONITOR_ID = testUlid();
const firing: MonitorObservation = { firing: true, summary: "3 failed runs." };
const clear: MonitorObservation = { firing: false };

function monitor(overrides: Partial<MonitorRecord["data"]> = {}) {
  return Schema.decodeUnknownSync(MonitorRecord)(
    withCanonicalRecordKeys({
      data: {
        condition: { kind: "run-failures", threshold: 3, windowMinutes: 15 },
        createdAt: NOW.toISOString(),
        environmentId: ENVIRONMENT_ID,
        id: MONITOR_ID,
        name: "Runs failing",
        notify: { emailPrincipalIds: [], emailRoles: ["owner"], webhooks: true },
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
        status: "active",
        updatedAt: NOW.toISOString(),
        version: 1,
        ...overrides,
      },
      itemType: "monitor" as const,
    }),
  );
}

function state(phase: "firing" | "ok", overrides: Partial<MonitorStateRecord["data"]> = {}) {
  return Schema.decodeUnknownSync(MonitorStateRecord)(
    withCanonicalRecordKeys({
      data: {
        createdAt: NOW.toISOString(),
        monitorId: MONITOR_ID,
        organizationId: ORGANIZATION_ID,
        phase,
        updatedAt: NOW.toISOString(),
        version: 2,
        ...(phase === "firing"
          ? { firingSince: "2026-11-02T09:00:00.000Z", incidentId: testUlid() }
          : {}),
        ...overrides,
      },
      itemType: "monitor-state" as const,
    }),
  );
}

const decide = (
  observation: MonitorObservation,
  current: MonitorStateRecord | undefined,
  configured = monitor(),
) => decideMonitorTransition({ monitor: configured, now: NOW, observation, state: current });

describe("monitor state machine", () => {
  test("ok fires on a firing observation and stays ok otherwise", () => {
    expect(decide(firing, undefined)).toEqual({ kind: "fire", notify: true });
    expect(decide(firing, state("ok"))).toEqual({ kind: "fire", notify: true });
    expect(decide(clear, state("ok"))).toEqual({ kind: "none" });
  });

  test("a firing monitor does nothing while the condition holds, so one incident notifies once", () => {
    expect(decide(firing, state("firing", { lastNotifiedAt: "2026-11-02T09:59:00.000Z" }))).toEqual(
      {
        kind: "none",
      },
    );
  });

  test("a firing monitor resolves when the condition clears, telling whoever heard it fire", () => {
    expect(decide(clear, state("firing", { lastNotifiedAt: "2026-11-02T09:00:00.000Z" }))).toEqual({
      kind: "resolve",
      notify: true,
      resolution: "condition-cleared",
    });
    expect(decide(clear, state("firing"))).toEqual({
      kind: "resolve",
      notify: false,
      resolution: "condition-cleared",
    });
  });

  test("re-notifies on the monitor's interval, counted from the last notification", () => {
    const repeating = monitor({ renotifyMinutes: 60 });
    expect(
      decide(firing, state("firing", { lastNotifiedAt: "2026-11-02T09:01:00.000Z" }), repeating),
    ).toEqual({ kind: "none" });
    expect(
      decide(firing, state("firing", { lastNotifiedAt: "2026-11-02T09:00:00.000Z" }), repeating),
    ).toEqual({ kind: "renotify", reason: "interval" });
  });

  test("re-notifies at once on new information", () => {
    expect(decide({ ...firing, escalation: true }, state("firing"))).toEqual({
      kind: "renotify",
      reason: "escalation",
    });
  });

  test("muted monitors open and resolve incidents without notifying until the mute ends", () => {
    const muted = monitor({ status: "muted" });
    expect(decide(firing, state("ok"), muted)).toEqual({ kind: "fire", notify: false });
    expect(decide({ ...firing, escalation: true }, state("firing"), muted)).toEqual({
      kind: "none",
    });
    expect(
      decide(clear, state("firing", { lastNotifiedAt: "2026-11-02T09:00:00.000Z" }), muted),
    ).toEqual({ kind: "resolve", notify: false, resolution: "condition-cleared" });

    const mutedUntilPast = monitor({ mutedUntil: "2026-11-02T09:00:00.000Z", status: "muted" });
    expect(decide(firing, state("ok"), mutedUntilPast)).toEqual({ kind: "fire", notify: true });
    const mutedUntilFuture = monitor({ mutedUntil: "2026-11-02T11:00:00.000Z", status: "muted" });
    expect(decide(firing, state("ok"), mutedUntilFuture)).toEqual({ kind: "fire", notify: false });
  });

  test("archiving resolves an open incident and never opens one", () => {
    const archived = monitor({ archivedAt: NOW.toISOString(), status: "archived" });
    expect(decide(firing, state("firing"), archived)).toEqual({
      kind: "resolve",
      notify: false,
      resolution: "monitor-archived",
    });
    expect(decide(firing, state("ok"), archived)).toEqual({ kind: "none" });
  });

  test("an event already applied changes nothing", () => {
    const eventId = testUlid();
    expect(
      decide(
        { ...firing, escalation: true, eventId },
        state("firing", { appliedEventIds: [eventId] }),
      ),
    ).toEqual({ kind: "none" });
  });
});
