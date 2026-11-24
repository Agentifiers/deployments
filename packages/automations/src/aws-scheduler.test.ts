import { describe, expect, test } from "bun:test";
import { CreateScheduleCommand, DeleteScheduleCommand } from "@aws-sdk/client-scheduler";
import type { Ulid } from "@deployments-ai/db";
import { createEventBridgeTimerProvider } from "./aws-scheduler.ts";

const scheduleId = "01ARZ3NDEKTSV4RRFFQ69G5FAV" as Ulid;

describe("EventBridge timer provider", () => {
  test("creates scoped schedules with AWS runtime placeholders", async () => {
    const commands: unknown[] = [];
    const provider = createEventBridgeTimerProvider({
      client: {
        send: async (command) => {
          commands.push(command);
          return {};
        },
      },
      deadLetterArn: "arn:aws:sqs:us-east-1:123456789012:runtime-automation-failures",
      groupName: "runtime",
      heartbeatTargetArn: "arn:aws:lambda:us-east-1:123456789012:function:heartbeat",
      roleArn: "arn:aws:iam::123456789012:role/scheduler",
      scheduleTargetArn: "arn:aws:lambda:us-east-1:123456789012:function:schedule",
    });
    await provider.upsert({
      expression: "at(2026-07-24T12:00:00)",
      kind: "schedule",
      payload: { organizationId: "org", scheduleId: "id", scheduleVersion: 3 },
      scheduleId,
    });
    expect(commands[0]).toBeInstanceOf(CreateScheduleCommand);
    const input = (commands[0] as CreateScheduleCommand).input;
    expect(input.ActionAfterCompletion).toBe("DELETE");
    expect(input.FlexibleTimeWindow).toEqual({ Mode: "OFF" });
    expect(input.State).toBe("ENABLED");
    expect(input.Target?.DeadLetterConfig).toEqual({
      Arn: "arn:aws:sqs:us-east-1:123456789012:runtime-automation-failures",
    });
    expect(JSON.parse(input.Target!.Input!)).toMatchObject({
      fireKey: "<aws.scheduler.scheduled-time>",
      scheduleVersion: 3,
    });
  });

  test("prepares schedules in a disabled state before activation", async () => {
    const commands: unknown[] = [];
    const provider = createEventBridgeTimerProvider({
      client: { send: async (command) => void commands.push(command) },
      deadLetterArn: "dead-letter",
      groupName: "runtime",
      heartbeatTargetArn: "heartbeat",
      roleArn: "role",
      scheduleTargetArn: "schedule",
    });

    await provider.upsert({
      enabled: false,
      expression: "rate(1 hour)",
      kind: "schedule",
      payload: { scheduleVersion: 2 },
      scheduleId,
    });

    expect((commands[0] as CreateScheduleCommand).input.State).toBe("DISABLED");
    expect((commands[0] as CreateScheduleCommand).input.ClientToken).toEndWith("-disabled");
  });

  test("idempotently deletes both provider target names", async () => {
    const commands: unknown[] = [];
    const provider = createEventBridgeTimerProvider({
      client: {
        send: async (command) => {
          commands.push(command);
          return {};
        },
      },
      deadLetterArn: "dead-letter",
      groupName: "runtime",
      heartbeatTargetArn: "heartbeat",
      roleArn: "role",
      scheduleTargetArn: "schedule",
    });
    await provider.delete(scheduleId);
    expect(commands).toHaveLength(2);
    expect(commands.every((command) => command instanceof DeleteScheduleCommand)).toBe(true);
  });
});
