import {
  CloudWatchClient,
  DescribeAlarmsCommand,
  type DescribeAlarmsCommandOutput,
  type StateValue,
} from "@aws-sdk/client-cloudwatch";
import {
  DescribeServicesCommand,
  ECSClient,
  type DescribeServicesCommandOutput,
} from "@aws-sdk/client-ecs";
import {
  LambdaClient,
  ListFunctionsCommand,
  type ListFunctionsCommandOutput,
} from "@aws-sdk/client-lambda";
import {
  DescribeSecretCommand,
  SecretsManagerClient,
  type DescribeSecretCommandOutput,
} from "@aws-sdk/client-secrets-manager";
import {
  DescribeParametersCommand,
  SSMClient,
  type DescribeParametersCommandOutput,
} from "@aws-sdk/client-ssm";
import { parseAwsSecretReference } from "@deployments-ai/secret-store";
import type {
  AlarmObservation,
  EcsServiceObservation,
  LambdaFunctionObservation,
  SystemAwsReaders,
} from "./readers.ts";

/** ECS DescribeServices accepts at most ten services per call. */
const ECS_DESCRIBE_BATCH = 10;
/** Lambda ListFunctions returns at most fifty functions per page. */
const LAMBDA_LIST_PAGE = 50;

interface CommandClient {
  send(command: object): Promise<unknown>;
}

export interface SystemAwsClients {
  readonly cloudWatch: CommandClient;
  readonly ecs: CommandClient;
  readonly lambda: CommandClient;
  readonly secretsManager: CommandClient;
  readonly ssm: CommandClient;
}

export function defaultSystemAwsClients(): SystemAwsClients {
  return {
    cloudWatch: new CloudWatchClient({}),
    ecs: new ECSClient({}),
    lambda: new LambdaClient({}),
    secretsManager: new SecretsManagerClient({}),
    ssm: new SSMClient({}),
  };
}

function isoTimestamp(value: Date | string | undefined) {
  if (value === undefined) return undefined;
  const milliseconds = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : undefined;
}

function awsErrorName(cause: unknown) {
  return typeof cause === "object" && cause !== null && "name" in cause
    ? String(cause.name)
    : undefined;
}

/**
 * AWS SDK readers restricted to describe/list calls. No reader requests a parameter or secret
 * value, Lambda code locations, or task-level data, and none keeps Lambda environment variables.
 */
export function makeSystemAwsReaders(clients: SystemAwsClients): SystemAwsReaders {
  return {
    async describeEcsServices(clusterName, serviceNames) {
      const observed = new Map<string, EcsServiceObservation>();
      for (let offset = 0; offset < serviceNames.length; offset += ECS_DESCRIBE_BATCH) {
        const output = (await clients.ecs.send(
          new DescribeServicesCommand({
            cluster: clusterName,
            services: serviceNames.slice(offset, offset + ECS_DESCRIBE_BATCH),
          }),
        )) as DescribeServicesCommandOutput;
        for (const service of output.services ?? []) {
          if (!service.serviceName) continue;
          const primary = service.deployments?.find(
            (deployment) => deployment.status === "PRIMARY",
          );
          observed.set(service.serviceName, {
            ...(service.desiredCount === undefined ? {} : { desiredCount: service.desiredCount }),
            ...(service.pendingCount === undefined ? {} : { pendingCount: service.pendingCount }),
            ...(primary?.rolloutState ? { rolloutState: primary.rolloutState } : {}),
            ...(primary?.rolloutStateReason
              ? { rolloutStateReason: primary.rolloutStateReason }
              : {}),
            ...(service.runningCount === undefined ? {} : { runningCount: service.runningCount }),
            serviceName: service.serviceName,
            ...(service.status ? { status: service.status } : {}),
            ...(service.taskDefinition ? { taskDefinition: service.taskDefinition } : {}),
          });
        }
      }
      return observed;
    },
    async listLambdaFunctions() {
      const observed = new Map<string, LambdaFunctionObservation>();
      let marker: string | undefined;
      do {
        const output = (await clients.lambda.send(
          new ListFunctionsCommand({
            MaxItems: LAMBDA_LIST_PAGE,
            ...(marker ? { Marker: marker } : {}),
          }),
        )) as ListFunctionsCommandOutput;
        for (const listed of output.Functions ?? []) {
          if (!listed.FunctionName) continue;
          const lastModified = isoTimestamp(listed.LastModified);
          observed.set(listed.FunctionName, {
            ...(listed.CodeSha256
              ? { codeSha256: Buffer.from(listed.CodeSha256, "base64").toString("hex") }
              : {}),
            ...(lastModified ? { lastModified } : {}),
          });
        }
        marker = output.NextMarker;
      } while (marker);
      return observed;
    },
    async describeAlarms(input) {
      const output = (await clients.cloudWatch.send(
        new DescribeAlarmsCommand({
          AlarmTypes: ["CompositeAlarm", "MetricAlarm"],
          MaxRecords: input.maxRecords,
          ...(input.namePrefix ? { AlarmNamePrefix: input.namePrefix } : {}),
          ...(input.nextToken ? { NextToken: input.nextToken } : {}),
          ...(input.state ? { StateValue: input.state as StateValue } : {}),
        }),
      )) as DescribeAlarmsCommandOutput;
      const alarms: AlarmObservation[] = [
        ...(output.MetricAlarms ?? []).map((alarm) => ({
          metricName: alarm.MetricName,
          name: alarm.AlarmName,
          namespace: alarm.Namespace,
          reason: alarm.StateReason,
          state: alarm.StateValue,
          updatedAt: isoTimestamp(alarm.StateUpdatedTimestamp),
        })),
        ...(output.CompositeAlarms ?? []).map((alarm) => ({
          metricName: undefined,
          name: alarm.AlarmName,
          namespace: undefined,
          reason: alarm.StateReason,
          state: alarm.StateValue,
          updatedAt: isoTimestamp(alarm.StateUpdatedTimestamp),
        })),
      ].flatMap((alarm) =>
        alarm.name && alarm.state
          ? [
              {
                name: alarm.name,
                state: alarm.state as AlarmObservation["state"],
                ...(alarm.metricName ? { metricName: alarm.metricName } : {}),
                ...(alarm.namespace ? { namespace: alarm.namespace } : {}),
                ...(alarm.reason ? { reason: alarm.reason } : {}),
                ...(alarm.updatedAt ? { updatedAt: alarm.updatedAt } : {}),
              },
            ]
          : [],
      );
      return { alarms, ...(output.NextToken ? { nextToken: output.NextToken } : {}) };
    },
    async describeSecret(reference) {
      const parsed = parseAwsSecretReference(reference);
      if (parsed.kind === "secret") {
        let output: DescribeSecretCommandOutput;
        try {
          output = (await clients.secretsManager.send(
            new DescribeSecretCommand({ SecretId: parsed.reference }),
          )) as typeof output;
        } catch (cause) {
          if (awsErrorName(cause) === "ResourceNotFoundException") return undefined;
          throw cause;
        }
        const currentVersionId = Object.entries(output.VersionIdsToStages ?? {}).find(
          ([, stages]) => stages.includes("AWSCURRENT"),
        )?.[0];
        const lastModifiedAt = isoTimestamp(output.LastChangedDate);
        return {
          kind: "secrets-manager",
          ...(currentVersionId ? { currentVersionId } : {}),
          ...(lastModifiedAt ? { lastModifiedAt } : {}),
        };
      }
      const name = `/${parsed.reference.slice(parsed.reference.indexOf(":parameter/") + ":parameter/".length)}`;
      const output = (await clients.ssm.send(
        new DescribeParametersCommand({
          ParameterFilters: [{ Key: "Name", Option: "Equals", Values: [name] }],
        }),
      )) as DescribeParametersCommandOutput;
      const parameter = output.Parameters?.find((candidate) => candidate.Name === name);
      if (!parameter) return undefined;
      const lastModifiedAt = isoTimestamp(parameter.LastModifiedDate);
      return {
        kind: "ssm-parameter",
        ...(lastModifiedAt ? { lastModifiedAt } : {}),
        ...(parameter.Version === undefined ? {} : { version: parameter.Version }),
      };
    },
  };
}
