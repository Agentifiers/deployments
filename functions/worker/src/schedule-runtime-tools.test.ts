import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import type { DynamoDatabaseService, PlatformRecord, Ulid } from "@deployments-ai/db";
import { createRuntimeScheduleBuiltinExecutors } from "./schedule-runtime-tools.ts";

const id = (suffix: string) => `01J000000000000000000000${suffix}` as Ulid;
const request = {
  agentDefinitionId: id("01"),
  agentDeploymentId: id("02"),
  agentReleaseId: id("03"),
  decision: {
    action: "allow" as const,
    reason: "test",
    toolCallId: "01KZPETZCR0000000000000000" as Ulid,
  },
  effect: "read" as const,
  environmentId: id("04"),
  idempotencyKey: "schedule-list-test",
  inputSummary: "List schedules",
  organizationId: id("05"),
  projectId: id("06"),
  requiredScopes: [],
  runId: id("07"),
  threadId: id("08"),
  toolName: "agent.schedule.list",
};

function schedule(scheduleId: Ulid, sequence: number) {
  return {
    data: {
      agentDeploymentId: request.agentDeploymentId,
      createdAt: `2026-07-30T00:00:0${sequence}.000Z`,
      environmentId: request.environmentId,
      id: scheduleId,
      name: `schedule-${sequence}`,
      organizationId: request.organizationId,
      projectId: request.projectId,
      prompt: "x".repeat(40_000),
      schedule: { expression: "rate(1 hour)", timezone: "UTC" },
      status: "active",
      updatedAt: `2026-07-30T00:00:0${sequence}.000Z`,
    },
    gsi2sk: `SCHEDULE#active#2026-07-30T00:00:0${sequence}.000Z#${scheduleId}`,
    itemType: "schedule",
    pk: "test",
    sk: "test",
  } as unknown as PlatformRecord;
}

/** A ready deployment whose release declares the schedule trigger, and the run's thread. */
function schedulingDatabase() {
  const records = new Map<string, PlatformRecord>();
  const partition = `ORG#${request.organizationId}#ENV#${request.environmentId}`;
  records.set(`${partition}\u0000AGENT-DEPLOYMENT#${request.agentDeploymentId}`, {
    data: {
      agentDefinitionId: request.agentDefinitionId,
      agentReleaseId: request.agentReleaseId,
      currentState: "ready",
      desiredState: "running",
      environmentId: request.environmentId,
      id: request.agentDeploymentId,
      organizationId: request.organizationId,
      projectId: request.projectId,
      version: 0,
    },
    itemType: "agent-deployment",
    pk: partition,
    sk: `AGENT-DEPLOYMENT#${request.agentDeploymentId}`,
  } as unknown as PlatformRecord);
  records.set(`${partition}\u0000AGENT-RELEASE#${request.agentReleaseId}`, {
    data: {
      agentDefinitionId: request.agentDefinitionId,
      contentHash: "sha256:test",
      environmentId: request.environmentId,
      id: request.agentReleaseId,
      manifest: { spec: { triggers: ["schedule"] } },
      organizationId: request.organizationId,
      projectId: request.projectId,
      status: "active",
      version: 0,
    },
    itemType: "agent-release",
    pk: partition,
    sk: `AGENT-RELEASE#${request.agentReleaseId}`,
  } as unknown as PlatformRecord);
  const threadPartition = `ORG#${request.organizationId}#THREAD#${request.threadId}`;
  records.set(`${threadPartition}\u0000THREAD#${request.threadId}`, {
    data: {
      agentDeploymentId: request.agentDeploymentId,
      archived: false,
      environmentId: request.environmentId,
      id: request.threadId,
      organizationId: request.organizationId,
      projectId: request.projectId,
      version: 0,
    },
    itemType: "thread",
    pk: threadPartition,
    sk: `THREAD#${request.threadId}`,
  } as unknown as PlatformRecord);
  const database = {
    deleteRecord: async () => {},
    getRecord: async (_table: unknown, key: { readonly pk: string; readonly sk: string }) =>
      records.get(`${key.pk}\u0000${key.sk}`),
    putRecord: async () => {},
    queryRecords: async () => ({ items: [] }),
    transactWrite: async (
      operations: readonly {
        readonly kind: string;
        readonly record?: PlatformRecord;
      }[],
    ) => {
      for (const operation of operations) {
        if (operation.kind === "put" && operation.record) {
          records.set(`${operation.record.pk}\u0000${operation.record.sk}`, operation.record);
        }
      }
    },
  } as unknown as DynamoDatabaseService;
  return { database, records };
}

describe("schedule runtime tools", () => {
  afterEach(() => setSystemTime());

  test("creates a one-shot reminder in the current thread from a relative delay", async () => {
    const timerSchedules: unknown[] = [];
    setSystemTime(new Date("2026-08-10T18:26:55.000Z"));
    const { database, records } = schedulingDatabase();
    const executor = createRuntimeScheduleBuiltinExecutors({
      database,
      generateId: async () => id("19"),
      timerProvider: {
        delete: async () => undefined,
        upsert: async (value) => {
          timerSchedules.push(value);
        },
      },
    })["agent.schedule.remind"];

    const reminderRequest = {
      ...request,
      runId: "01KZP6DZ000000000000000000" as Ulid,
      effect: "write" as const,
      input: {
        delayMinutes: 60,
        name: "Distract Rowan after work",
        prompt: "Send Rowan one natural, teasing follow-up now.",
      },
      toolName: "agent.schedule.remind" as const,
    };
    const result = await executor(reminderRequest, {} as never);
    setSystemTime(new Date("2026-08-10T18:31:55.000Z"));
    const replay = await executor(reminderRequest, {} as never);

    expect(JSON.parse(String(result.artifacts?.[0]?.content))).toMatchObject({
      expression: "at(2026-08-10T19:26:55)",
      threadId: request.threadId,
    });
    expect(replay).toEqual(result);
    expect(timerSchedules).toEqual([
      expect.objectContaining({
        expression: "at(2026-08-10T19:26:55)",
        kind: "schedule",
      }),
    ]);
    expect([...records.values()]).toContainEqual(
      expect.objectContaining({
        data: expect.objectContaining({
          createdBy: { id: "01J00000000000000000000002", type: "agent" },
          createdFrom: {
            runId: "01KZP6DZ000000000000000000",
            threadId: "01J00000000000000000000008",
            toolCallId: "01KZPETZCR0000000000000000",
            toolName: "agent.schedule.remind",
          },
        }),
        itemType: "schedule",
      }),
    );
  });

  test("a recurring schedule an agent creates records the tool call it came from", async () => {
    const { database, records } = schedulingDatabase();
    const executor = createRuntimeScheduleBuiltinExecutors({
      database,
      generateId: async () => id("19"),
      timerProvider: { delete: async () => undefined, upsert: async () => undefined },
    })["agent.schedule.create"];

    await executor(
      {
        ...request,
        decision: { ...request.decision, toolCallId: "01KZPETZCR0000000000000001" as Ulid },
        effect: "write",
        input: {
          expression: "0 9 ? * MON-FRI *",
          kind: "cron",
          name: "Weekday standup",
          prompt: "Post the standup summary.",
        },
        toolName: "agent.schedule.create",
      },
      {} as never,
    );

    expect([...records.values()]).toContainEqual(
      expect.objectContaining({
        data: expect.objectContaining({
          createdBy: { id: "01J00000000000000000000002", type: "agent" },
          createdFrom: {
            runId: "01J00000000000000000000007",
            threadId: "01J00000000000000000000008",
            toolCallId: "01KZPETZCR0000000000000001",
            toolName: "agent.schedule.create",
          },
          schedule: expect.objectContaining({ expression: "cron(0 9 ? * MON-FRI *)" }),
        }),
        itemType: "schedule",
      }),
    );
  });

  test("paginates bounded compact schedule listings", async () => {
    const newest = schedule(id("10"), 2);
    const oldest = schedule(id("11"), 1);
    const database = {
      deleteRecord: async () => {},
      getRecord: async () => undefined,
      putRecord: async () => {},
      queryRecords: async (_table: unknown, input: Readonly<Record<string, unknown>>) => {
        const values = input.ExpressionAttributeValues as Readonly<Record<string, unknown>>;
        return {
          items: values[":sk"] === "SCHEDULE#" ? [newest, oldest] : [oldest],
        };
      },
      transactWrite: async () => {},
    } as unknown as DynamoDatabaseService;
    const executor = createRuntimeScheduleBuiltinExecutors({
      database,
      generateId: async () => id("19"),
      timerProvider: {
        delete: async () => undefined,
        upsert: async () => undefined,
      },
    })["agent.schedule.list"];

    const first = await executor({ ...request, input: { limit: 1 } }, {} as never);
    const firstPage = JSON.parse(String(first.artifacts?.[0]?.content));
    expect(firstPage.schedules).toEqual([
      expect.objectContaining({ id: id("10"), promptTruncated: true }),
    ]);
    expect(firstPage.schedules[0].prompt.length).toBe(1_024);
    expect(firstPage.nextCursor).toBeString();

    const second = await executor(
      { ...request, input: { cursor: firstPage.nextCursor, limit: 1 } },
      {} as never,
    );
    expect(JSON.parse(String(second.artifacts?.[0]?.content)).schedules).toEqual([
      expect.objectContaining({ id: id("11") }),
    ]);
  });

  test("continues after unrelated schedules consume a bounded scan slice", async () => {
    const current = schedule(id("12"), 1);
    const foreign = Array.from({ length: 250 }, (_, index) => {
      const record = schedule(id(String(20 + (index % 70)).padStart(2, "0")), 2);
      return {
        ...record,
        data: { ...record.data, agentDeploymentId: id("13") },
        gsi2sk: `SCHEDULE#active#2026-07-31T00:00:00.000Z#${String(index).padStart(3, "0")}`,
      } as PlatformRecord;
    });
    const database = {
      deleteRecord: async () => {},
      getRecord: async () => undefined,
      putRecord: async () => {},
      queryRecords: async (_table: unknown, input: Readonly<Record<string, unknown>>) => {
        const values = input.ExpressionAttributeValues as Readonly<Record<string, unknown>>;
        return values[":sk"] === "SCHEDULE#"
          ? { items: foreign, lastEvaluatedKey: { cursor: "more" } }
          : { items: [current] };
      },
      transactWrite: async () => {},
    } as unknown as DynamoDatabaseService;
    const executor = createRuntimeScheduleBuiltinExecutors({
      database,
      generateId: async () => id("19"),
      timerProvider: {
        delete: async () => undefined,
        upsert: async () => undefined,
      },
    })["agent.schedule.list"];

    const first = JSON.parse(
      String((await executor({ ...request, input: {} }, {} as never)).artifacts?.[0]?.content),
    );
    expect(first.schedules).toEqual([]);
    expect(first.nextCursor).toBeString();

    const second = JSON.parse(
      String(
        (await executor({ ...request, input: { cursor: first.nextCursor } }, {} as never))
          .artifacts?.[0]?.content,
      ),
    );
    expect(second.schedules).toEqual([expect.objectContaining({ id: id("12") })]);
  });

  test("does not archive a workspace schedule from an environment-scoped run", async () => {
    const workspaceSchedule = schedule(id("14"), 1);
    const database = {
      deleteRecord: async () => {},
      getRecord: async () =>
        ({
          ...workspaceSchedule,
          data: { ...workspaceSchedule.data, workspaceId: id("15") },
        }) as PlatformRecord,
      putRecord: async () => {},
      queryRecords: async () => ({ items: [] }),
      transactWrite: async () => {},
    } as unknown as DynamoDatabaseService;
    const executor = createRuntimeScheduleBuiltinExecutors({
      database,
      generateId: async () => id("19"),
      timerProvider: {
        delete: async () => undefined,
        upsert: async () => undefined,
      },
    })["agent.schedule.archive"];

    expect(
      executor(
        {
          ...request,
          effect: "write",
          input: { scheduledJobId: id("14") },
          toolName: "agent.schedule.archive",
        },
        {} as never,
      ),
    ).rejects.toThrow("current agent workspace");
  });
});
