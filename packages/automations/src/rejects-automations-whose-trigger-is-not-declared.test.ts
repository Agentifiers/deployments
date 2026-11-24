import {
  AgentDeploymentRecord,
  tableForItemType,
  withCanonicalRecordKeys,
  type DynamoDatabaseService,
} from "@deployments-ai/db";
import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import {
  agentDeploymentId,
  agentReleaseRecord,
  dependencies,
  ids,
  memoryDatabase,
  now,
  scope,
  tenantScope,
  workspaceRecord,
} from "./automation.fixture.ts";
import {
  createHeartbeat,
  createSchedule,
  fireHeartbeat,
  fireSchedule,
  validateScheduleExpression,
} from "./index.ts";

describe("automation control plane", () => {
  test("rejects automations whose trigger is not declared by the pinned release", async () => {
    const memory = memoryDatabase();
    memory.put(agentReleaseRecord(["api"]));
    const fixture = dependencies(memory);

    expect(
      createSchedule(
        {
          ...scope,
          agentDeploymentId,
          expression: "rate(1 hour)",
          idempotencyKey: "disallowed-schedule",
          name: "Disallowed schedule",
          prompt: "This must not be provisioned.",
        },
        fixture.dependencies,
      ),
    ).rejects.toMatchObject({ code: "trigger_not_allowed" });
    expect(
      createHeartbeat(
        {
          ...scope,
          agentDeploymentId,
          idempotencyKey: "disallowed-heartbeat",
          instructions: "This must not be provisioned.",
          intervalMs: 60_000,
        },
        fixture.dependencies,
      ),
    ).rejects.toMatchObject({ code: "trigger_not_allowed" });

    expect(memory.transactions).toHaveLength(0);
    expect(fixture.providerSchedules).toHaveLength(0);
  });

  test("validates EventBridge expressions and creates an idempotently fired schedule", async () => {
    expect(validateScheduleExpression("cron(0 12 * * ? *)")).toBe("cron(0 12 * * ? *)");
    expect(validateScheduleExpression("cron(0/15 8-17 ? JAN,MAR MON-FRI 2026)")).toBe(
      "cron(0/15 8-17 ? JAN,MAR MON-FRI 2026)",
    );
    expect(validateScheduleExpression("at(2026-07-24T12:00:00)")).toBe("at(2026-07-24T12:00:00)");
    expect(() => validateScheduleExpression("every day")).toThrow("EventBridge");
    expect(() => validateScheduleExpression("rate(foo)")).toThrow("EventBridge");
    expect(() => validateScheduleExpression(`rate(1${" ".repeat(247)}day)`)).toThrow("exceeds 256");
    expect(() => validateScheduleExpression("rate(1 hours)")).toThrow("EventBridge");
    expect(() => validateScheduleExpression("at(not-a-date)")).toThrow("EventBridge");
    expect(() => validateScheduleExpression("cron(foo bar baz qux quux corge)")).toThrow(
      "EventBridge",
    );
    expect(() => validateScheduleExpression("cron(60 12 * * ? *)")).toThrow("EventBridge");
    expect(() => validateScheduleExpression("cron(0 12 99W * ? *)")).toThrow("EventBridge");
    expect(() => validateScheduleExpression("cron(0 12 L-999 * ? *)")).toThrow("EventBridge");
    expect(() => validateScheduleExpression("cron(0 12 ? * 99L *)")).toThrow("EventBridge");
    expect(() => validateScheduleExpression("cron(0 12 ? * 3#1,6#3 *)")).toThrow("EventBridge");
    expect(() => validateScheduleExpression("cron(0 12 ? * 3#1,6 *)")).toThrow("EventBridge");
    expect(() => validateScheduleExpression("cron(0 17-8 ? * MON-FRI 2026)")).toThrow(
      "EventBridge",
    );
    expect(() => validateScheduleExpression("cron(0 12 ? DEC-JAN MON-FRI 2026)")).toThrow(
      "EventBridge",
    );
    const memory = memoryDatabase();
    const fixture = dependencies(memory);
    expect(
      createSchedule(
        {
          ...scope,
          agentDeploymentId,
          expression: "rate(1 hour)",
          idempotencyKey: "timezone-too-long",
          name: "Hourly check",
          prompt: "Check production health",
          timezone: "x".repeat(51),
        },
        fixture.dependencies,
      ),
    ).rejects.toThrow("50 characters");
    const schedule = await createSchedule(
      {
        ...scope,
        agentDeploymentId,
        expression: "rate(1 hour)",
        idempotencyKey: "create-hourly-check",
        name: "Hourly check",
        prompt: "Check production health",
        timezone: "America/Phoenix",
      },
      fixture.dependencies,
    );

    const first = await fireSchedule(
      { ...tenantScope, fireKey: "2026-07-23T12:00:00.000Z", scheduleId: schedule.data.id },
      fixture.dependencies,
    );
    const replay = await fireSchedule(
      { ...scope, fireKey: "2026-07-23T12:00:00.000Z", scheduleId: schedule.data.id },
      fixture.dependencies,
    );

    expect(fixture.providerSchedules).toHaveLength(1);
    expect(fixture.providerSchedules).toMatchObject([{ enabled: true }]);
    expect(fixture.providerSchedules[0]).toMatchObject({
      payload: { workspaceId: scope.workspaceId },
    });
    expect(fixture.runs).toHaveLength(1);
    expect(fixture.runs[0]).toMatchObject({ workspaceId: scope.workspaceId });
    expect(first.duplicate).toBe(false);
    expect(first.fire.data.status).toBe("accepted");
    expect(replay.duplicate).toBe(true);
  });

  test("reconciles automation creation retries and rejects conflicting key reuse", async () => {
    const memory = memoryDatabase();
    const fixture = dependencies(memory);
    const scheduleInput = {
      ...scope,
      agentDeploymentId,
      expression: "rate(1 hour)",
      idempotencyKey: "stable-schedule-create",
      name: "Hourly check",
      prompt: "Check production health",
    };
    const heartbeatInput = {
      ...scope,
      agentDeploymentId,
      idempotencyKey: "stable-heartbeat-create",
      instructions: "Review queued work",
      intervalMs: 60_000,
    };

    const schedule = await createSchedule(scheduleInput, fixture.dependencies);
    const heartbeat = await createHeartbeat(heartbeatInput, fixture.dependencies);
    memory.put(workspaceRecord(scope.workspaceId, "archived"));
    const scheduleReplay = await createSchedule(scheduleInput, fixture.dependencies);
    const heartbeatReplay = await createHeartbeat(heartbeatInput, fixture.dependencies);

    expect(scheduleReplay.data.id).toBe(schedule.data.id);
    expect(heartbeatReplay.data.id).toBe(heartbeat.data.id);
    expect(memory.transactions).toHaveLength(6);
    expect(fixture.providerSchedules).toHaveLength(2);
    expect(fixture.providerSchedules[1]).toMatchObject({
      enabled: true,
      expression: "rate(1 minute)",
    });
    expect(
      createSchedule({ ...scheduleInput, prompt: "Different prompt" }, fixture.dependencies),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    expect(
      createHeartbeat({ ...heartbeatInput, agentDeploymentId: ids[27]! }, fixture.dependencies),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
  });

  test("scopes automation creation identities by workspace", async () => {
    const memory = memoryDatabase();
    const fixture = dependencies(memory);
    const base = {
      ...scope,
      agentDeploymentId,
      expression: "rate(1 hour)",
      idempotencyKey: "workspace-local-key",
      name: "Hourly check",
      prompt: "Check production health",
    };

    const first = await createSchedule(base, fixture.dependencies);
    memory.put(workspaceRecord(ids[5]!));
    const second = await createSchedule({ ...base, workspaceId: ids[5]! }, fixture.dependencies);

    expect(second.data.id).not.toBe(first.data.id);
  });

  test("does not recreate an active one-time timer on creation replay", async () => {
    const memory = memoryDatabase();
    const fixture = dependencies(memory);
    const input = {
      ...scope,
      agentDeploymentId,
      expression: "at(2026-07-24T12:00:00)",
      idempotencyKey: "one-time-schedule",
      name: "One-time check",
      prompt: "Check production health once",
    };

    const created = await createSchedule(input, fixture.dependencies);
    const replay = await createSchedule(input, fixture.dependencies);

    expect(replay.data.id).toBe(created.data.id);
    expect(replay.data.status).toBe("active");
    expect(fixture.providerSchedules).toHaveLength(1);
  });

  test("reconciles heartbeat conflicts through the canonical creation event", async () => {
    const memory = memoryDatabase();
    const fixture = dependencies(memory);
    const heartbeatInput = {
      ...scope,
      agentDeploymentId,
      idempotencyKey: "racing-heartbeat-create",
      instructions: "Review queued work",
      intervalMs: 60_000,
    };
    await createHeartbeat(heartbeatInput, fixture.dependencies);
    const conflictingDeployment = Schema.decodeUnknownSync(AgentDeploymentRecord)(
      withCanonicalRecordKeys({
        data: {
          agentDefinitionId: ids[26]!,
          agentReleaseId: ids[25]!,
          createdAt: now.toISOString(),
          currentState: "ready" as const,
          desiredState: "running" as const,
          environmentId: scope.environmentId,
          id: ids[27]!,
          organizationId: scope.organizationId,
          projectId: scope.projectId,
          updatedAt: now.toISOString(),
          version: 0,
        },
        itemType: "agent-deployment" as const,
      }),
    );
    memory.records.set(
      `${tableForItemType(conflictingDeployment.itemType)}\u0000${conflictingDeployment.pk}\u0000${conflictingDeployment.sk}`,
      conflictingDeployment,
    );
    const database = {
      ...memory.database,
      queryRecords: () =>
        Promise.reject(new Error("heartbeat creation must not scan the environment")),
      transactWrite: () => Promise.reject(new Error("race")),
    } as unknown as DynamoDatabaseService;

    expect(
      createHeartbeat(
        { ...heartbeatInput, agentDeploymentId: conflictingDeployment.data.id },
        { ...fixture.dependencies, database },
      ),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
  });

  test("records busy and outside-window heartbeat skips without submitting runs", async () => {
    const memory = memoryDatabase();
    const fixture = dependencies(memory);
    const heartbeat = await createHeartbeat(
      {
        ...scope,
        activeWindow: { daysOfWeek: [4], endMinuteOfDay: 13 * 60, startMinuteOfDay: 11 * 60 },
        agentDeploymentId,
        idempotencyKey: "create-windowed-heartbeat",
        instructions: "Review queued work",
        intervalMs: 60_000,
        timezone: "UTC",
      },
      fixture.dependencies,
    );
    const busy = await fireHeartbeat(
      {
        ...scope,
        agentDeploymentId,
        fireKey: "busy-fire",
        hasActiveRun: async () => true,
        heartbeatId: heartbeat.data.id,
      },
      fixture.dependencies,
    );

    expect(busy.heartbeatRun.data.status).toBe("skipped");
    expect(busy.heartbeatRun.data.skipReason).toBe("busy");
    expect(fixture.runs).toHaveLength(0);
    expect(fixture.providerSchedules[0]).toMatchObject({
      payload: { workspaceId: scope.workspaceId },
    });
    expect(
      (fixture.providerSchedules[0] as { payload: Record<string, unknown> }).payload,
    ).toHaveProperty("scheduleVersion", 0);
  });

  test("bounds derived run idempotency keys for long fire keys", async () => {
    const memory = memoryDatabase();
    const fixture = dependencies(memory);
    const schedule = await createSchedule(
      {
        ...scope,
        agentDeploymentId,
        expression: "rate(1 hour)",
        idempotencyKey: "long-fire-schedule",
        name: "Long fire key",
        prompt: "Run safely",
      },
      fixture.dependencies,
    );
    const heartbeat = await createHeartbeat(
      {
        ...scope,
        agentDeploymentId,
        idempotencyKey: "long-fire-heartbeat",
        instructions: "Run safely",
        intervalMs: 60_000,
      },
      fixture.dependencies,
    );
    const fireKey = "f".repeat(512);

    await fireSchedule({ ...scope, fireKey, scheduleId: schedule.data.id }, fixture.dependencies);
    await fireHeartbeat(
      { ...scope, agentDeploymentId, fireKey, heartbeatId: heartbeat.data.id },
      fixture.dependencies,
    );

    for (const run of fixture.runs as Array<{ readonly idempotencyKey: string }>) {
      expect(new TextEncoder().encode(run.idempotencyKey).byteLength).toBeLessThanOrEqual(256);
      expect(run.idempotencyKey).not.toContain(fireKey);
    }

    const runCount = fixture.runs.length;
    expect(
      fireSchedule(
        { ...scope, fireKey: "😀".repeat(129), scheduleId: schedule.data.id },
        fixture.dependencies,
      ),
    ).rejects.toThrow("at most 512 UTF-8 bytes");
    expect(
      fireSchedule(
        { ...scope, fireKey: "😀".repeat(128), scheduleId: schedule.data.id },
        fixture.dependencies,
      ),
    ).rejects.toThrow("too large after DynamoDB key encoding");
    expect(
      fireHeartbeat(
        {
          ...scope,
          agentDeploymentId,
          fireKey: "😀".repeat(129),
          heartbeatId: heartbeat.data.id,
        },
        fixture.dependencies,
      ),
    ).rejects.toThrow("at most 512 UTF-8 bytes");
    expect(fixture.runs).toHaveLength(runCount);
  });

  test("keeps recurring heartbeats live across mutable record versions", async () => {
    const memory = memoryDatabase();
    const fixture = dependencies(memory);
    const heartbeat = await createHeartbeat(
      {
        ...scope,
        agentDeploymentId,
        idempotencyKey: "create-recurring-heartbeat",
        instructions: "Review queued work",
        intervalMs: 60_000,
      },
      fixture.dependencies,
    );

    await fireHeartbeat(
      { ...scope, agentDeploymentId, fireKey: "first", heartbeatId: heartbeat.data.id },
      fixture.dependencies,
    );
    await fireHeartbeat(
      { ...scope, agentDeploymentId, fireKey: "second", heartbeatId: heartbeat.data.id },
      fixture.dependencies,
    );

    expect(fixture.runs).toHaveLength(2);
    expect(
      (fixture.runs as Array<{ readonly idempotencyKey: string }>).map((run) => run.idempotencyKey),
    ).toEqual([
      expect.stringMatching(/^heartbeat:[^:]+:[^:]+$/u),
      expect.stringMatching(/^heartbeat:[^:]+:[^:]+$/u),
    ]);
  });

  test("rejects heartbeat intervals that EventBridge cannot represent exactly", async () => {
    const memory = memoryDatabase();
    const fixture = dependencies(memory);

    expect(
      createHeartbeat(
        {
          ...scope,
          agentDeploymentId,
          idempotencyKey: "invalid-heartbeat-interval",
          instructions: "Review queued work",
          intervalMs: 61_000,
        },
        fixture.dependencies,
      ),
    ).rejects.toThrow("whole number of minutes");
    expect(fixture.providerSchedules).toHaveLength(0);
  });

  test("validates deployment and active-window inputs before provisioning timers", async () => {
    const memory = memoryDatabase();
    const fixture = dependencies(memory);

    expect(
      createSchedule(
        {
          ...scope,
          agentDeploymentId: ids[27]!,
          expression: "rate(1 hour)",
          idempotencyKey: "invalid-schedule-deployment",
          name: "Invalid deployment",
          prompt: "Do not provision",
        },
        fixture.dependencies,
      ),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(
      createHeartbeat(
        {
          ...scope,
          activeWindow: {},
          agentDeploymentId,
          idempotencyKey: "invalid-heartbeat-window",
          instructions: "Do not provision",
        },
        fixture.dependencies,
      ),
    ).rejects.toMatchObject({ code: "invalid_heartbeat" });
    expect(fixture.providerSchedules).toHaveLength(0);
  });

  test("bounds and normalizes heartbeat active-window days", async () => {
    const memory = memoryDatabase();
    const fixture = dependencies(memory);

    const heartbeat = await createHeartbeat(
      {
        ...scope,
        activeWindow: {
          daysOfWeek: [5, 1, 3],
          endMinuteOfDay: 1020,
          startMinuteOfDay: 540,
        },
        agentDeploymentId,
        idempotencyKey: "normalized-heartbeat-days",
        instructions: "Review queued work",
      },
      fixture.dependencies,
    );
    expect(heartbeat.data.activeWindow).toMatchObject({ daysOfWeek: [1, 3, 5] });
    expect(
      createHeartbeat(
        {
          ...scope,
          activeWindow: {
            daysOfWeek: [1, 1],
            endMinuteOfDay: 1020,
            startMinuteOfDay: 540,
          },
          agentDeploymentId,
          idempotencyKey: "duplicate-heartbeat-days",
          instructions: "Review queued work",
        },
        fixture.dependencies,
      ),
    ).rejects.toMatchObject({ code: "invalid_heartbeat" });
  });

  test("keeps a canonical record retryable when timer provisioning fails", async () => {
    const memory = memoryDatabase();
    const fixture = dependencies(memory);
    fixture.dependencies.timerProvider = {
      delete: async (scheduleId) => {
        fixture.providerDeletes.push(scheduleId);
      },
      upsert: async () => {
        throw new Error("scheduler unavailable");
      },
    };

    const input = {
      ...scope,
      agentDeploymentId,
      expression: "rate(1 hour)",
      idempotencyKey: "failed-schedule-provision",
      name: "Hourly check",
      prompt: "Check production health",
    };
    expect(createSchedule(input, fixture.dependencies)).rejects.toThrow("scheduler unavailable");
    const persisted = [...memory.records.values()].find((record) => record.itemType === "schedule");
    expect(persisted).toBeDefined();
    if (!persisted || persisted.itemType !== "schedule") {
      throw new Error("Schedule was not preserved after timer provisioning failed.");
    }
    expect(persisted).toMatchObject({
      data: { schedule: { timerActivationPending: true }, status: "active", version: 1 },
    });
    fixture.dependencies.timerProvider = {
      delete: async () => {},
      upsert: async (schedule) => void fixture.providerSchedules.push(schedule),
    };

    const retried = await createSchedule(input, fixture.dependencies);

    expect(retried.data.id).toBe(persisted.data.id);
    expect(retried.data.status).toBe("active");
    expect(fixture.providerDeletes).toHaveLength(0);
    expect(fixture.providerSchedules).toHaveLength(1);
  });

  test("keeps a canonical record retryable when no timer provider is configured", async () => {
    const memory = memoryDatabase();
    const fixture = dependencies(memory);
    const { timerProvider: _timerProvider, ...withoutTimerProvider } = fixture.dependencies;
    const input = {
      ...scope,
      agentDeploymentId,
      expression: "rate(1 hour)",
      idempotencyKey: "missing-timer-provider",
      name: "Hourly check",
      prompt: "Check production health",
    };

    expect(createSchedule(input, withoutTimerProvider)).rejects.toMatchObject({
      code: "timer_provider_unavailable",
    });
    expect(
      [...memory.records.values()].find((record) => record.itemType === "schedule"),
    ).toMatchObject({ data: { status: "provisioning" } });
  });

  test("keeps a failed heartbeat provisioning record visibly incomplete", async () => {
    const memory = memoryDatabase();
    const fixture = dependencies(memory);
    fixture.dependencies.timerProvider = {
      delete: async () => {},
      upsert: async () => {
        throw new Error("scheduler unavailable");
      },
    };
    const input = {
      ...scope,
      agentDeploymentId,
      idempotencyKey: "failed-heartbeat-provision",
      instructions: "Review queued work",
      intervalMs: 60_000,
    };

    expect(createHeartbeat(input, fixture.dependencies)).rejects.toThrow("scheduler unavailable");
    const persisted = [...memory.records.values()].find(
      (record) => record.itemType === "heartbeat",
    );
    expect(persisted).toMatchObject({
      data: { schedule: { timerActivationPending: true }, status: "active", version: 1 },
    });

    fixture.dependencies.timerProvider = {
      delete: async () => {},
      upsert: async (schedule) => void fixture.providerSchedules.push(schedule),
    };
    const retried = await createHeartbeat(input, fixture.dependencies);

    expect(retried.data.status).toBe("active");
    expect(fixture.providerSchedules).toHaveLength(1);
  });
});
