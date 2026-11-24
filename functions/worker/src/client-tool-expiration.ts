import type { RuntimePendingAction } from "@deployments-ai/agent-runtime";
import {
  ConflictException,
  CreateScheduleCommand,
  SchedulerClient,
  UpdateScheduleCommand,
} from "@aws-sdk/client-scheduler";
import { Ulid } from "@deployments-ai/db";
import { Schema } from "effect";
import {
  ApprovalResolutionError,
  type ResolveRunApprovalDependencies,
  type ResolveRunToolResult,
} from "./approval-shared.ts";
import { CLIENT_TOOL_EXPIRED_SUMMARY } from "./client-tool-results.ts";
import { resolveRunToolResult } from "./tool-result-resolution.ts";
import type { RunRecordValue } from "./types.ts";

const CLIENT_TOOL_EXPIRATION_ENV = {
  deadLetterArn: "DEPLOYMENTS_AI_AUTOMATION_FAILURE_QUEUE_ARN",
  groupName: "DEPLOYMENTS_AI_SCHEDULER_GROUP",
  roleArn: "DEPLOYMENTS_AI_SCHEDULER_ROLE_ARN",
  targetArn: "DEPLOYMENTS_AI_CLIENT_TOOL_TIMEOUT_LAMBDA_ARN",
} as const;

/** Durable command delivered by EventBridge Scheduler when a client tool call's deadline passes. */
export const ClientToolExpirationCommand = Schema.Struct({
  environmentId: Ulid,
  organizationId: Ulid,
  projectId: Ulid,
  runId: Ulid,
  threadId: Ulid,
  toolCallId: Ulid,
});
export type ClientToolExpirationCommand = typeof ClientToolExpirationCommand.Type;

interface ClientToolExpirationSchedule extends ClientToolExpirationCommand {
  readonly expiresAt: string;
}

export type ScheduleClientToolExpiration = (input: ClientToolExpirationSchedule) => Promise<void>;

function schedulerAtExpression(expiresAt: string): string {
  const timestamp = new Date(expiresAt);
  if (!Number.isFinite(timestamp.getTime())) {
    throw new TypeError("Client tool expiresAt is invalid.");
  }
  const rounded = new Date(Math.ceil(timestamp.getTime() / 1_000) * 1_000);
  return `at(${rounded.toISOString().replace(/\.\d{3}Z$/u, "")})`;
}

/**
 * Schedules a one-time EventBridge Scheduler invocation of the client tool timeout handler at the
 * tool call deadline. Configuration is read on first use so workers that never pause on a client
 * tool do not require it.
 */
export function createClientToolExpirationScheduler(
  options: {
    readonly client?: Pick<SchedulerClient, "send">;
    readonly env?: NodeJS.ProcessEnv;
  } = {},
): ScheduleClientToolExpiration {
  const env = options.env ?? process.env;
  let client = options.client;
  return async (input) => {
    const configuration = Object.fromEntries(
      Object.entries(CLIENT_TOOL_EXPIRATION_ENV).map(([key, name]) => {
        const value = env[name]?.trim();
        if (!value) throw new Error(`${name} is required for client tool expiration.`);
        return [key, value];
      }),
    ) as Record<keyof typeof CLIENT_TOOL_EXPIRATION_ENV, string>;
    client ??= new SchedulerClient({});
    const name = `client-tool-${input.toolCallId}`;
    const command: ClientToolExpirationCommand = {
      environmentId: input.environmentId,
      organizationId: input.organizationId,
      projectId: input.projectId,
      runId: input.runId,
      threadId: input.threadId,
      toolCallId: input.toolCallId,
    };
    const schedule = {
      ActionAfterCompletion: "DELETE" as const,
      Description: `Expire client tool call ${input.toolCallId}`,
      FlexibleTimeWindow: { Mode: "OFF" as const },
      GroupName: configuration.groupName,
      Name: name,
      ScheduleExpression: schedulerAtExpression(input.expiresAt),
      State: "ENABLED" as const,
      Target: {
        Arn: configuration.targetArn,
        DeadLetterConfig: { Arn: configuration.deadLetterArn },
        Input: JSON.stringify(command),
        RetryPolicy: { MaximumEventAgeInSeconds: 86_400, MaximumRetryAttempts: 3 },
        RoleArn: configuration.roleArn,
      },
    };
    try {
      await client.send(new CreateScheduleCommand({ ...schedule, ClientToken: name }));
    } catch (cause) {
      if (!(cause instanceof ConflictException)) throw cause;
      await client.send(new UpdateScheduleCommand(schedule));
    }
  };
}

/** Schedules the deadline for a paused client tool call; no-op for other pending actions. */
export async function scheduleClientToolPauseExpiration(
  schedule: ScheduleClientToolExpiration | undefined,
  run: RunRecordValue,
  pendingAction: RuntimePendingAction,
): Promise<void> {
  if (pendingAction.kind !== "tool" || !pendingAction.client) return;
  if (!schedule) {
    throw new Error("Client tool expiration scheduling is unavailable to the worker.");
  }
  await schedule({
    environmentId: run.data.environmentId,
    expiresAt: pendingAction.client.expiresAt,
    organizationId: run.data.organizationId,
    projectId: run.data.projectId,
    runId: run.data.id,
    threadId: run.data.threadId,
    toolCallId: pendingAction.toolCallId,
  });
}

export type ClientToolExpirationOutcome =
  | { readonly status: "expired"; readonly result: ResolveRunToolResult }
  | { readonly status: "resolved" };

/**
 * Fails an expired client tool call and resumes its run so the model can recover. Tool calls that
 * were already resolved, or whose run moved on, are left untouched. A call that has not reached
 * its deadline yet throws so the scheduler retries delivery.
 */
export async function expireClientToolCall(
  command: ClientToolExpirationCommand,
  dependencies: ResolveRunApprovalDependencies,
): Promise<ClientToolExpirationOutcome> {
  try {
    const result = await resolveRunToolResult(
      { ...command, outcome: "failed", outputSummary: CLIENT_TOOL_EXPIRED_SUMMARY },
      dependencies,
      { expired: true },
    );
    return { result, status: "expired" };
  } catch (cause) {
    if (
      cause instanceof ApprovalResolutionError &&
      (cause.code === "tool_call_already_resolved" ||
        cause.code === "run_not_waiting_for_tool" ||
        cause.code === "tool_call_not_found" ||
        cause.code === "run_not_found")
    ) {
      return { status: "resolved" };
    }
    throw cause;
  }
}
