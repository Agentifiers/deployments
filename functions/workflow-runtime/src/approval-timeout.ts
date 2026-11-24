import {
  ConflictException,
  CreateScheduleCommand,
  SchedulerClient,
  UpdateScheduleCommand,
  type SchedulerClientConfig,
} from "@aws-sdk/client-scheduler";
import type { WorkflowDispatchDependencies } from "./types.ts";

const ENV = {
  deadLetterArn: "DEPLOYMENTS_AI_AUTOMATION_FAILURE_QUEUE_ARN",
  groupName: "DEPLOYMENTS_AI_SCHEDULER_GROUP",
  roleArn: "DEPLOYMENTS_AI_SCHEDULER_ROLE_ARN",
  targetArn: "DEPLOYMENTS_AI_WORKFLOW_APPROVAL_TIMEOUT_LAMBDA_ARN",
} as const;

function required(env: NodeJS.ProcessEnv, name: string) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function atExpression(expiresAt: string) {
  const timestamp = new Date(expiresAt);
  if (!Number.isFinite(timestamp.getTime())) throw new TypeError("Approval expiresAt is invalid.");
  const schedulerTimestamp = new Date(Math.ceil(timestamp.getTime() / 1_000) * 1_000);
  return `at(${schedulerTimestamp.toISOString().replace(/\.\d{3}Z$/u, "")})`;
}

export function createWorkflowApprovalExpirationScheduler(
  options: {
    readonly client?: Pick<SchedulerClient, "send">;
    readonly clientConfig?: SchedulerClientConfig;
    readonly env?: NodeJS.ProcessEnv;
  } = {},
): NonNullable<WorkflowDispatchDependencies["scheduleApprovalExpiration"]> {
  const env = options.env ?? process.env;
  const client = options.client ?? new SchedulerClient(options.clientConfig ?? {});
  const deadLetterArn = required(env, ENV.deadLetterArn);
  const groupName = required(env, ENV.groupName);
  const roleArn = required(env, ENV.roleArn);
  const targetArn = required(env, ENV.targetArn);

  return async ({ approvalId, executionId, expiresAt, organizationId }) => {
    const name = `workflow-approval-${approvalId}`;
    const input = {
      ActionAfterCompletion: "DELETE" as const,
      Description: `Expire workflow approval ${approvalId}`,
      FlexibleTimeWindow: { Mode: "OFF" as const },
      GroupName: groupName,
      Name: name,
      ScheduleExpression: atExpression(expiresAt),
      State: "ENABLED" as const,
      Target: {
        Arn: targetArn,
        DeadLetterConfig: { Arn: deadLetterArn },
        Input: JSON.stringify({ approvalId, executionId, organizationId }),
        RetryPolicy: { MaximumEventAgeInSeconds: 86_400, MaximumRetryAttempts: 3 },
        RoleArn: roleArn,
      },
    };
    try {
      await client.send(new CreateScheduleCommand({ ...input, ClientToken: name }));
    } catch (cause) {
      if (!(cause instanceof ConflictException)) throw cause;
      await client.send(new UpdateScheduleCommand(input));
    }
  };
}
