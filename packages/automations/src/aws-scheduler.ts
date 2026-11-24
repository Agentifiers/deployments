import {
  ConflictException,
  CreateScheduleCommand,
  DeleteScheduleCommand,
  ResourceNotFoundException,
  SchedulerClient,
  UpdateScheduleCommand,
  type SchedulerClientConfig,
} from "@aws-sdk/client-scheduler";
import type { TimerProvider, TimerProviderSchedule } from "./index.ts";

export interface EventBridgeTimerProviderOptions {
  readonly client?: Pick<SchedulerClient, "send">;
  readonly clientConfig?: SchedulerClientConfig;
  readonly deadLetterArn: string;
  readonly groupName: string;
  readonly heartbeatTargetArn: string;
  readonly roleArn: string;
  readonly scheduleTargetArn: string;
}

const SCHEDULED_TIME = "<aws.scheduler.scheduled-time>";

function required(value: string, label: string) {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required.`);
  return normalized;
}

function scheduleName(kind: TimerProviderSchedule["kind"], scheduleId: string) {
  return `${kind}-${scheduleId}`;
}

function commandInput(schedule: TimerProviderSchedule, options: EventBridgeTimerProviderOptions) {
  const targetArn =
    schedule.kind === "heartbeat" ? options.heartbeatTargetArn : options.scheduleTargetArn;
  return {
    ...(schedule.expression.startsWith("at(") ? { ActionAfterCompletion: "DELETE" as const } : {}),
    Description: `Deployments.ai ${schedule.kind} ${schedule.scheduleId}`,
    FlexibleTimeWindow: { Mode: "OFF" as const },
    GroupName: required(options.groupName, "Scheduler group name"),
    Name: scheduleName(schedule.kind, schedule.scheduleId),
    ScheduleExpression: schedule.expression,
    ...(schedule.timezone ? { ScheduleExpressionTimezone: schedule.timezone } : {}),
    State: schedule.enabled === false ? ("DISABLED" as const) : ("ENABLED" as const),
    Target: {
      Arn: required(targetArn, `${schedule.kind} target ARN`),
      DeadLetterConfig: { Arn: required(options.deadLetterArn, "Scheduler dead-letter ARN") },
      Input: JSON.stringify({ ...schedule.payload, fireKey: SCHEDULED_TIME }),
      RetryPolicy: { MaximumEventAgeInSeconds: 86_400, MaximumRetryAttempts: 3 },
      RoleArn: required(options.roleArn, "Scheduler invocation role ARN"),
    },
  };
}

export function createEventBridgeTimerDeleter(
  options: Pick<EventBridgeTimerProviderOptions, "client" | "clientConfig" | "groupName">,
): Pick<TimerProvider, "delete"> {
  const client = options.client ?? new SchedulerClient(options.clientConfig ?? {});
  return {
    async delete(scheduleId) {
      for (const kind of ["schedule", "heartbeat"] as const) {
        try {
          await client.send(
            new DeleteScheduleCommand({
              GroupName: required(options.groupName, "Scheduler group name"),
              Name: scheduleName(kind, scheduleId),
            }),
          );
        } catch (cause) {
          if (!(cause instanceof ResourceNotFoundException)) throw cause;
        }
      }
    },
  };
}

export function createEventBridgeTimerProvider(
  options: EventBridgeTimerProviderOptions,
): TimerProvider {
  const client = options.client ?? new SchedulerClient(options.clientConfig ?? {});
  return {
    ...createEventBridgeTimerDeleter({ client, groupName: options.groupName }),
    async upsert(schedule) {
      const input = commandInput(schedule, options);
      try {
        await client.send(
          new CreateScheduleCommand({
            ...input,
            ClientToken: `${schedule.kind}-${schedule.scheduleId}-${typeof schedule.payload.scheduleVersion === "number" ? schedule.payload.scheduleVersion : 0}-${schedule.enabled === false ? "disabled" : "enabled"}`,
          }),
        );
      } catch (cause) {
        if (!(cause instanceof ConflictException)) throw cause;
        await client.send(new UpdateScheduleCommand(input));
      }
    },
  };
}
