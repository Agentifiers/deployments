import { describe, expect, test } from "bun:test";
import { makeSystemAwsReaders, type SystemAwsClients } from "./aws-readers.ts";

const METADATA_COMMANDS = new Set([
  "DescribeAlarmsCommand",
  "DescribeParametersCommand",
  "DescribeSecretCommand",
  "DescribeServicesCommand",
  "ListFunctionsCommand",
]);

interface SentCommand {
  readonly input: Readonly<Record<string, unknown>>;
  readonly name: string;
}

function recordingClients(responses: (command: SentCommand) => unknown) {
  const sent: SentCommand[] = [];
  const client = {
    send: async (command: {
      readonly constructor: { readonly name: string };
      readonly input: Readonly<Record<string, unknown>>;
    }) => {
      const recorded = { input: command.input, name: command.constructor.name };
      sent.push(recorded);
      const response = responses(recorded);
      if (response instanceof Error) throw response;
      return response;
    },
  };
  return {
    clients: {
      cloudWatch: client,
      ecs: client,
      lambda: client,
      secretsManager: client,
      ssm: client,
    } satisfies SystemAwsClients,
    sent,
  };
}

describe("system AWS readers", () => {
  test("only issue metadata reads and map their responses", async () => {
    const codeHex = "ab".repeat(32);
    const { clients, sent } = recordingClients(({ input, name }) => {
      switch (name) {
        case "DescribeServicesCommand": {
          const services = Array.isArray(input.services) ? input.services.map(String) : [];
          return {
            failures: [],
            services: services.map((serviceName) => ({
              deployments: [
                {
                  rolloutState: "FAILED",
                  rolloutStateReason: "circuit breaker",
                  status: "PRIMARY",
                },
              ],
              desiredCount: 1,
              pendingCount: 0,
              runningCount: 0,
              serviceName,
              status: "ACTIVE",
            })),
          };
        }
        case "ListFunctionsCommand":
          return input.Marker === undefined
            ? {
                Functions: [
                  {
                    CodeSha256: Buffer.from(codeHex, "hex").toString("base64"),
                    Environment: { Variables: { TABLE: "platform" } },
                    FunctionName: "api",
                    LastModified: "2026-10-01T10:00:00.000+0000",
                  },
                ],
                NextMarker: "page-2",
              }
            : { Functions: [{ FunctionName: "worker" }] };
        case "DescribeAlarmsCommand":
          return {
            CompositeAlarms: [{ AlarmName: "composite", StateValue: "OK" }],
            MetricAlarms: [
              {
                AlarmName: "api-5xx",
                MetricName: "5xx",
                Namespace: "AWS/ApiGateway",
                StateReason: "Threshold crossed",
                StateUpdatedTimestamp: new Date("2026-10-01T09:00:00.000Z"),
                StateValue: "ALARM",
              },
            ],
            NextToken: "next",
          };
        case "DescribeParametersCommand":
          return {
            Parameters: [
              {
                LastModifiedDate: new Date("2026-09-01T00:00:00.000Z"),
                Name: "/models/openai-api-key",
                Version: 2,
              },
            ],
          };
        case "DescribeSecretCommand":
          return {
            LastChangedDate: new Date("2026-09-02T00:00:00.000Z"),
            VersionIdsToStages: { old: ["AWSPREVIOUS"], v2: ["AWSCURRENT"] },
          };
        default:
          throw new Error(`Unexpected ${name}`);
      }
    });
    const readers = makeSystemAwsReaders(clients);
    const services = Array.from({ length: 12 }, (_, index) => `service-${index}`);

    const ecs = await readers.describeEcsServices("models", services);
    const lambda = await readers.listLambdaFunctions();
    const alarms = await readers.describeAlarms({ maxRecords: 10, namePrefix: "acme-" });
    const parameter = await readers.describeSecret(
      "arn:aws:ssm:us-east-2:123456789012:parameter/models/openai-api-key",
    );
    const secret = await readers.describeSecret(
      "arn:aws:secretsmanager:us-east-2:123456789012:secret:openrouter-AbCdEf",
    );

    expect(sent.every((command) => METADATA_COMMANDS.has(command.name))).toBe(true);
    expect(
      sent
        .filter((command) => command.name === "DescribeServicesCommand")
        .map((command) =>
          Array.isArray(command.input.services) ? command.input.services.length : 0,
        ),
    ).toEqual([10, 2]);
    expect(ecs.get("service-11")).toMatchObject({
      desiredCount: 1,
      rolloutState: "FAILED",
      rolloutStateReason: "circuit breaker",
      runningCount: 0,
    });
    expect(lambda).toEqual(
      new Map([
        ["api", { codeSha256: codeHex, lastModified: "2026-10-01T10:00:00.000Z" }],
        ["worker", {}],
      ]),
    );
    expect(
      sent.filter((command) => command.name === "ListFunctionsCommand").map(({ input }) => input),
    ).toEqual([{ MaxItems: 50 }, { Marker: "page-2", MaxItems: 50 }]);
    expect(alarms).toEqual({
      alarms: [
        {
          metricName: "5xx",
          name: "api-5xx",
          namespace: "AWS/ApiGateway",
          reason: "Threshold crossed",
          state: "ALARM",
          updatedAt: "2026-10-01T09:00:00.000Z",
        },
        { name: "composite", state: "OK" },
      ],
      nextToken: "next",
    });
    expect(sent.find((command) => command.name === "DescribeAlarmsCommand")?.input).toMatchObject({
      AlarmNamePrefix: "acme-",
      MaxRecords: 10,
    });
    expect(parameter).toEqual({
      kind: "ssm-parameter",
      lastModifiedAt: "2026-09-01T00:00:00.000Z",
      version: 2,
    });
    expect(sent.find((command) => command.name === "DescribeParametersCommand")?.input).toEqual({
      ParameterFilters: [{ Key: "Name", Option: "Equals", Values: ["/models/openai-api-key"] }],
    });
    expect(secret).toEqual({
      currentVersionId: "v2",
      kind: "secrets-manager",
      lastModifiedAt: "2026-09-02T00:00:00.000Z",
    });
  });
});
