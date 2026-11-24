import { describe, expect, test } from "bun:test";
import {
  HeartbeatRecord,
  ScheduleRecord,
  withCanonicalRecordKeys,
  type PlatformRecord,
} from "@deployments-ai/db";
import { Schema } from "effect";
import {
  archiveHeartbeat,
  archiveSchedule,
  createHeartbeat,
  createSchedule,
  fireSchedule,
  getHeartbeat,
  getSchedule,
  fireHeartbeat,
  pauseHeartbeat,
  pauseSchedule,
  resumeHeartbeat,
  resumeSchedule,
  type TimerProviderSchedule,
  updateHeartbeat,
  updateSchedule,
} from "./index.ts";
import {
  agentDeploymentId,
  dependencies,
  memoryDatabase,
  scope,
  workspaceRecord,
} from "./automation.fixture.ts";
import { finishTimerProvisioning } from "./timer-provisioning.ts";

describe("automation lifecycle", () => {
  test("updates, pauses, resumes, gets, and archives schedules", async () => {
    const memory = memoryDatabase();
    const fixture = dependencies(memory);
    const created = await createSchedule(
      {
        ...scope,
        agentDeploymentId,
        expression: "rate(1 hour)",
        idempotencyKey: "schedule-lifecycle",
        name: "Hourly",
        prompt: "Check health",
      },
      fixture.dependencies,
    );

    const updated = await updateSchedule(
      {
        ...scope,
        expression: "rate(2 hours)",
        name: "Every two hours",
        scheduleId: created.data.id,
        timezone: "America/Phoenix",
      },
      fixture.dependencies,
    );
    expect(updated.data).toMatchObject({
      name: "Every two hours",
      schedule: {
        expression: "rate(2 hours)",
        timerVersion: 1,
        timezone: "America/Phoenix",
      },
      status: "active",
    });
    expect(
      (await getSchedule({ ...scope, scheduleId: created.data.id }, fixture.dependencies)).data,
    ).toMatchObject({ status: "active" });
    const clearedTimezone = await updateSchedule(
      {
        ...scope,
        scheduleId: created.data.id,
        timezone: null,
      },
      fixture.dependencies,
    );
    expect(clearedTimezone.data.schedule.timezone).toBeUndefined();
    expect(clearedTimezone.data.schedule.timerVersion).toBe(2);

    const paused = await pauseSchedule(
      { ...scope, scheduleId: created.data.id },
      fixture.dependencies,
    );
    expect(paused.data.status).toBe("paused");
    expect(fixture.providerSchedules.at(-1)).toMatchObject({ enabled: false });

    const resumed = await resumeSchedule(
      { ...scope, scheduleId: created.data.id },
      fixture.dependencies,
    );
    expect(resumed.data.status).toBe("active");
    expect(resumed.data.schedule.timerVersion).toBe(2);
    expect(fixture.providerSchedules.at(-1)).toMatchObject({ enabled: true });
    const provisionedEventIds = [...memory.records.values()]
      .filter(
        (record): record is Extract<PlatformRecord, { readonly itemType: "semantic-event" }> =>
          record.itemType === "semantic-event" && record.data.eventType === "schedule.provisioned",
      )
      .map((record) => record.data.eventId);
    expect(provisionedEventIds.length).toBeGreaterThanOrEqual(4);
    expect(new Set(provisionedEventIds).size).toBe(provisionedEventIds.length);
    const scheduleWritesBeforeMetadataUpdate = fixture.providerSchedules.length;
    const renamed = await updateSchedule(
      {
        ...scope,
        name: "Renamed without timer change",
        scheduleId: created.data.id,
      },
      fixture.dependencies,
    );
    expect(renamed.data.status).toBe("active");
    expect(fixture.providerSchedules).toHaveLength(scheduleWritesBeforeMetadataUpdate);

    const archived = await archiveSchedule(
      { ...scope, scheduleId: created.data.id },
      fixture.dependencies,
    );
    expect(archived.data.status).toBe("archived");
    expect(fixture.providerDeletes).toContain(created.data.id);
    expect(
      resumeSchedule({ ...scope, scheduleId: created.data.id }, fixture.dependencies),
    ).rejects.toMatchObject({ code: "automation_archived" });
  });

  test("updates, pauses, resumes, gets, and archives heartbeats by ID", async () => {
    const memory = memoryDatabase();
    const fixture = dependencies(memory);
    const created = await createHeartbeat(
      {
        ...scope,
        agentDeploymentId,
        idempotencyKey: "heartbeat-lifecycle",
        instructions: "Review work",
        intervalMs: 60_000,
      },
      fixture.dependencies,
    );

    const updated = await updateHeartbeat(
      {
        ...scope,
        heartbeatId: created.data.id,
        activeWindow: { endMinuteOfDay: 1_020, startMinuteOfDay: 540 },
        instructions: "Review all queued work",
        intervalMs: 120_000,
        skipWhenBusy: false,
        timezone: "UTC",
      },
      fixture.dependencies,
    );
    expect(updated.data.schedule).toMatchObject({
      instructions: "Review all queued work",
      intervalMs: 120_000,
      skipWhenBusy: false,
      timerVersion: 1,
      timezone: "UTC",
    });
    const clearedWindow = await updateHeartbeat(
      {
        ...scope,
        activeWindow: null,
        heartbeatId: created.data.id,
        timezone: null,
      },
      fixture.dependencies,
    );
    expect(clearedWindow.data.activeWindow).toBeUndefined();
    expect(clearedWindow.data.schedule.timezone).toBeUndefined();
    expect(clearedWindow.data.schedule.timerVersion).toBe(2);
    expect(
      (await getHeartbeat({ ...scope, heartbeatId: created.data.id }, fixture.dependencies)).data
        .id,
    ).toBe(created.data.id);

    expect(
      (await pauseHeartbeat({ ...scope, heartbeatId: created.data.id }, fixture.dependencies)).data
        .status,
    ).toBe("paused");
    expect(
      (await resumeHeartbeat({ ...scope, heartbeatId: created.data.id }, fixture.dependencies)).data
        .status,
    ).toBe("active");
    const heartbeatWritesBeforeMetadataUpdate = fixture.providerSchedules.length;
    const reinstructed = await updateHeartbeat(
      {
        ...scope,
        heartbeatId: created.data.id,
        instructions: "Updated without timer change",
      },
      fixture.dependencies,
    );
    expect(reinstructed.data.status).toBe("active");
    expect(fixture.providerSchedules).toHaveLength(heartbeatWritesBeforeMetadataUpdate);
    const archived = await archiveHeartbeat(
      { ...scope, heartbeatId: created.data.id },
      fixture.dependencies,
    );
    expect(archived.data.status).toBe("archived");
    expect(fixture.providerDeletes).toContain(created.data.id);
  });

  test("rejects resume after the automation workspace is archived", async () => {
    const memory = memoryDatabase();
    const fixture = dependencies(memory);
    const schedule = await createSchedule(
      {
        ...scope,
        agentDeploymentId,
        expression: "rate(1 hour)",
        idempotencyKey: "resume-archived-workspace-schedule",
        name: "Paused schedule",
        prompt: "Remain paused",
      },
      fixture.dependencies,
    );
    const heartbeat = await createHeartbeat(
      {
        ...scope,
        agentDeploymentId,
        idempotencyKey: "resume-archived-workspace-heartbeat",
        instructions: "Remain paused",
        intervalMs: 60_000,
      },
      fixture.dependencies,
    );
    await pauseSchedule({ ...scope, scheduleId: schedule.data.id }, fixture.dependencies);
    await pauseHeartbeat({ ...scope, heartbeatId: heartbeat.data.id }, fixture.dependencies);
    memory.put(workspaceRecord(scope.workspaceId, "archived"));

    expect(
      resumeSchedule({ ...scope, scheduleId: schedule.data.id }, fixture.dependencies),
    ).rejects.toMatchObject({ code: "workspace_unavailable" });
    expect(
      resumeHeartbeat({ ...scope, heartbeatId: heartbeat.data.id }, fixture.dependencies),
    ).rejects.toMatchObject({ code: "workspace_unavailable" });
    expect(
      (await getSchedule({ ...scope, scheduleId: schedule.data.id }, fixture.dependencies)).data
        .status,
    ).toBe("paused");
    expect(
      (await getHeartbeat({ ...scope, heartbeatId: heartbeat.data.id }, fixture.dependencies)).data
        .status,
    ).toBe("paused");
  });

  test("persists a stable timer version when resuming a legacy heartbeat", async () => {
    const memory = memoryDatabase();
    const fixture = dependencies(memory);
    const created = await createHeartbeat(
      {
        ...scope,
        agentDeploymentId,
        idempotencyKey: "legacy-heartbeat",
        instructions: "Continue recurring",
        intervalMs: 60_000,
      },
      fixture.dependencies,
    );
    const { timerVersion: _timerVersion, ...legacySchedule } = created.data.schedule;
    memory.put(
      Schema.decodeUnknownSync(HeartbeatRecord)(
        withCanonicalRecordKeys({
          data: { ...created.data, schedule: legacySchedule },
          itemType: "heartbeat" as const,
        }),
      ),
    );

    await pauseHeartbeat({ ...scope, heartbeatId: created.data.id }, fixture.dependencies);
    const resumed = await resumeHeartbeat(
      { ...scope, heartbeatId: created.data.id },
      fixture.dependencies,
    );
    expect(Number.isSafeInteger(resumed.data.schedule.timerVersion)).toBe(true);

    const scheduleVersion = Number(resumed.data.schedule.timerVersion);
    const first = await fireHeartbeat(
      {
        ...scope,
        agentDeploymentId,
        fireKey: "legacy-first",
        heartbeatId: created.data.id,
        scheduleVersion,
      },
      fixture.dependencies,
    );
    const second = await fireHeartbeat(
      {
        ...scope,
        agentDeploymentId,
        fireKey: "legacy-second",
        heartbeatId: created.data.id,
        scheduleVersion,
      },
      fixture.dependencies,
    );
    expect(first.heartbeatRun.data.status).toBe("accepted");
    expect(second.heartbeatRun.data.status).toBe("accepted");
  });

  test("preserves legacy timer versions across metadata-only updates", async () => {
    const memory = memoryDatabase();
    const fixture = dependencies(memory);
    const createdSchedule = await createSchedule(
      {
        ...scope,
        agentDeploymentId,
        expression: "rate(1 hour)",
        idempotencyKey: "legacy-schedule-metadata",
        name: "Legacy schedule",
        prompt: "Keep the existing timer version",
      },
      fixture.dependencies,
    );
    const legacyScheduleVersion = createdSchedule.data.version;
    const { timerVersion: _scheduleTimerVersion, ...legacyScheduleConfiguration } =
      createdSchedule.data.schedule;
    memory.put(
      Schema.decodeUnknownSync(ScheduleRecord)(
        withCanonicalRecordKeys({
          data: {
            ...createdSchedule.data,
            schedule: legacyScheduleConfiguration,
          },
          itemType: "schedule" as const,
        }),
      ),
    );
    const updatedSchedule = await updateSchedule(
      {
        ...scope,
        name: "Renamed legacy schedule",
        scheduleId: createdSchedule.data.id,
      },
      fixture.dependencies,
    );
    expect(updatedSchedule.data.schedule.timerVersion).toBe(legacyScheduleVersion);
    expect(
      (
        await fireSchedule(
          {
            ...scope,
            fireKey: "legacy-schedule-fire",
            scheduleId: createdSchedule.data.id,
            scheduleVersion: legacyScheduleVersion,
          },
          fixture.dependencies,
        )
      ).fire.data.status,
    ).toBe("accepted");

    const createdHeartbeat = await createHeartbeat(
      {
        ...scope,
        agentDeploymentId,
        idempotencyKey: "legacy-heartbeat-metadata",
        instructions: "Keep the existing timer version",
        intervalMs: 60_000,
      },
      fixture.dependencies,
    );
    const legacyHeartbeatVersion = createdHeartbeat.data.version;
    const { timerVersion: _heartbeatTimerVersion, ...legacyHeartbeatSchedule } =
      createdHeartbeat.data.schedule;
    memory.put(
      Schema.decodeUnknownSync(HeartbeatRecord)(
        withCanonicalRecordKeys({
          data: { ...createdHeartbeat.data, schedule: legacyHeartbeatSchedule },
          itemType: "heartbeat" as const,
        }),
      ),
    );
    const updatedHeartbeat = await updateHeartbeat(
      {
        ...scope,
        heartbeatId: createdHeartbeat.data.id,
        instructions: "Updated without replacing the timer",
      },
      fixture.dependencies,
    );
    expect(updatedHeartbeat.data.schedule.timerVersion).toBe(legacyHeartbeatVersion);
  });

  test("persists active pending state before enabling updated or resumed timers", async () => {
    const memory = memoryDatabase();
    const fixture = dependencies(memory);
    const created = await createSchedule(
      {
        ...scope,
        agentDeploymentId,
        expression: "rate(1 hour)",
        idempotencyKey: "timer-activation-order",
        name: "Activation order",
        prompt: "Persist before enabling",
      },
      fixture.dependencies,
    );
    const baseProvider = fixture.dependencies.timerProvider!;
    const enabledStates: unknown[] = [];
    const observingDependencies = {
      ...fixture.dependencies,
      timerProvider: {
        delete: baseProvider.delete,
        upsert: async (input: TimerProviderSchedule) => {
          if (input.enabled) {
            const stored = [...memory.records.values()].find(
              (record) => record.itemType === "schedule" && record.data.id === created.data.id,
            );
            enabledStates.push(
              stored?.itemType === "schedule"
                ? {
                    pending: stored.data.schedule.timerActivationPending,
                    status: stored.data.status,
                  }
                : undefined,
            );
          }
          await baseProvider.upsert(input);
        },
      },
    };

    await updateSchedule(
      {
        ...scope,
        expression: "rate(2 hours)",
        scheduleId: created.data.id,
      },
      observingDependencies,
    );
    await pauseSchedule({ ...scope, scheduleId: created.data.id }, observingDependencies);
    await resumeSchedule({ ...scope, scheduleId: created.data.id }, observingDependencies);

    expect(enabledStates).toEqual([
      { pending: true, status: "active" },
      { pending: true, status: "active" },
    ]);
  });

  test("reconciles pending timer activation during metadata-only updates", async () => {
    const memory = memoryDatabase();
    const fixture = dependencies(memory);
    const created = await createSchedule(
      {
        ...scope,
        agentDeploymentId,
        expression: "rate(1 hour)",
        idempotencyKey: "metadata-reconciles-pending-timer",
        name: "Pending activation",
        prompt: "Reconcile on rename",
      },
      fixture.dependencies,
    );
    const baseProvider = fixture.dependencies.timerProvider!;
    let failEnable = true;
    const failingDependencies = {
      ...fixture.dependencies,
      timerProvider: {
        delete: baseProvider.delete,
        upsert: async (input: TimerProviderSchedule) => {
          if (input.enabled && failEnable) {
            failEnable = false;
            throw new Error("enable unavailable");
          }
          await baseProvider.upsert(input);
        },
      },
    };
    expect(
      updateSchedule(
        {
          ...scope,
          expression: "rate(2 hours)",
          scheduleId: created.data.id,
        },
        failingDependencies,
      ),
    ).rejects.toThrow("enable unavailable");
    expect(
      (await getSchedule({ ...scope, scheduleId: created.data.id }, fixture.dependencies)).data
        .schedule.timerActivationPending,
    ).toBe(true);

    const reconciled = await updateSchedule(
      {
        ...scope,
        name: "Renamed while activation was pending",
        scheduleId: created.data.id,
      },
      fixture.dependencies,
    );
    expect(reconciled.data).toMatchObject({
      name: "Renamed while activation was pending",
      status: "active",
    });
    expect(reconciled.data.schedule).not.toHaveProperty("timerActivationPending");
    expect(fixture.providerSchedules.at(-1)).toMatchObject({ enabled: true });
  });

  test("reconciles timer side effects when lifecycle calls are retried", async () => {
    const memory = memoryDatabase();
    const fixture = dependencies(memory);
    const created = await createSchedule(
      {
        ...scope,
        agentDeploymentId,
        expression: "rate(1 hour)",
        idempotencyKey: "schedule-reconciliation",
        name: "Reconciliation",
        prompt: "Reconcile timer side effects",
      },
      fixture.dependencies,
    );
    const baseProvider = fixture.dependencies.timerProvider!;
    let failDisable = true;
    let failEnable = true;
    let failDelete = true;
    const retryingDependencies = {
      ...fixture.dependencies,
      timerProvider: {
        delete: async (scheduleId: typeof created.data.id) => {
          if (failDelete) {
            failDelete = false;
            throw new Error("delete unavailable");
          }
          await baseProvider.delete(scheduleId);
        },
        upsert: async (input: TimerProviderSchedule) => {
          if (!input.enabled && failDisable) {
            failDisable = false;
            throw new Error("disable unavailable");
          }
          if (input.enabled && failEnable) {
            failEnable = false;
            throw new Error("enable unavailable");
          }
          await baseProvider.upsert(input);
        },
      },
    };

    expect(
      pauseSchedule({ ...scope, scheduleId: created.data.id }, retryingDependencies),
    ).rejects.toThrow("disable unavailable");
    expect(
      (await getSchedule({ ...scope, scheduleId: created.data.id }, retryingDependencies)).data
        .status,
    ).toBe("paused");
    expect(
      (await pauseSchedule({ ...scope, scheduleId: created.data.id }, retryingDependencies)).data
        .status,
    ).toBe("paused");

    expect(
      resumeSchedule({ ...scope, scheduleId: created.data.id }, retryingDependencies),
    ).rejects.toThrow("enable unavailable");
    expect(
      (await getSchedule({ ...scope, scheduleId: created.data.id }, retryingDependencies)).data
        .status,
    ).toBe("active");
    expect(
      (await getSchedule({ ...scope, scheduleId: created.data.id }, retryingDependencies)).data
        .schedule.timerActivationPending,
    ).toBe(true);
    expect(
      (await resumeSchedule({ ...scope, scheduleId: created.data.id }, retryingDependencies)).data
        .status,
    ).toBe("active");

    failDelete = true;
    expect(
      archiveSchedule({ ...scope, scheduleId: created.data.id }, retryingDependencies),
    ).rejects.toThrow("delete unavailable");
    expect(
      (await getSchedule({ ...scope, scheduleId: created.data.id }, retryingDependencies)).data
        .status,
    ).toBe("archived");
    expect(
      (await archiveSchedule({ ...scope, scheduleId: created.data.id }, retryingDependencies)).data
        .status,
    ).toBe("archived");
    expect(fixture.providerDeletes).toContain(created.data.id);
  });

  test("does not let stale timer finalization resurrect a paused or archived schedule", async () => {
    for (const action of ["pause", "archive"] as const) {
      const memory = memoryDatabase();
      const fixture = dependencies(memory);
      const created = await createSchedule(
        {
          ...scope,
          agentDeploymentId,
          expression: "rate(1 hour)",
          idempotencyKey: `schedule-finalization-race-${action}`,
          name: "Finalization race",
          prompt: "Remain inactive after lifecycle cancellation",
        },
        fixture.dependencies,
      );
      const provisioning = Schema.decodeUnknownSync(ScheduleRecord)(
        withCanonicalRecordKeys({
          data: {
            ...created.data,
            schedule: {
              ...created.data.schedule,
              timerActivationPending: true,
            },
            status: "provisioning" as const,
            version: created.data.version + 1,
          },
          itemType: "schedule" as const,
        }),
      );
      memory.put(provisioning);

      const canceled =
        action === "pause"
          ? await pauseSchedule({ ...scope, scheduleId: created.data.id }, fixture.dependencies)
          : await archiveSchedule({ ...scope, scheduleId: created.data.id }, fixture.dependencies);
      expect(canceled.data.schedule).not.toHaveProperty("timerActivationPending");

      let rejectStaleFinalization = true;
      const baseDatabase = fixture.dependencies.database;
      const raceDependencies = {
        ...fixture.dependencies,
        database: {
          ...baseDatabase,
          transactWrite: (operations: Parameters<typeof baseDatabase.transactWrite>[0]) => {
            if (rejectStaleFinalization) {
              rejectStaleFinalization = false;
              return Promise.reject(new Error("conditional transaction conflict"));
            }
            return baseDatabase.transactWrite(operations);
          },
        } as typeof baseDatabase,
      };
      const reconciled = await finishTimerProvisioning(provisioning, raceDependencies);
      expect(reconciled.data.status).toBe(action === "pause" ? "paused" : "archived");
      const persisted = await getSchedule(
        { ...scope, scheduleId: created.data.id },
        fixture.dependencies,
      );
      expect(persisted.data.status).toBe(action === "pause" ? "paused" : "archived");
      if (action === "pause") {
        expect(fixture.providerSchedules.at(-1)).toMatchObject({
          enabled: false,
        });
      } else {
        expect(fixture.providerDeletes.filter((id) => id === created.data.id)).toHaveLength(2);
      }
    }
  });
});
