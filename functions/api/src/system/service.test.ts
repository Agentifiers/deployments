import { describe, expect, test } from "bun:test";
import type { Installation } from "@deployments-ai/db";
import { makeSystemAwsReaders } from "./aws-readers.ts";
import type { AlarmObservation, EcsServiceObservation } from "./readers.ts";
import {
  API_CODE_SHA256,
  CONFIGURATION,
  fakeReaders,
  fakeService,
  INSTALLATION,
  operatorRequest,
} from "./system-operator.fixture.ts";

describe("system operator service", () => {
  test("reports ECS rollout health and Lambda code drift against each function's recorded code", async () => {
    const service = fakeService({
      installation: INSTALLATION,
      readers: fakeReaders({
        describeEcsServices: async (cluster, services) => {
          const observed: EcsServiceObservation[] =
            cluster === "models"
              ? [
                  {
                    desiredCount: 2,
                    pendingCount: 0,
                    rolloutState: "COMPLETED",
                    runningCount: 2,
                    serviceName: "bifrost",
                    status: "ACTIVE",
                  },
                  {
                    desiredCount: 2,
                    pendingCount: 1,
                    rolloutState: "IN_PROGRESS",
                    runningCount: 1,
                    serviceName: "agent-worker",
                    status: "ACTIVE",
                  },
                ]
              : [];
          return new Map(
            observed
              .filter((service) => services.includes(service.serviceName))
              .map((service) => [service.serviceName, service]),
          );
        },
        listLambdaFunctions: async () =>
          new Map([
            ["api", { codeSha256: API_CODE_SHA256 }],
            ["governance-worker", { codeSha256: "f".repeat(64) }],
          ]),
      }),
    });

    const report = (await service("getSystemComponents", operatorRequest())) as {
      ecsServices: { component: string; health: string; runningCount: number | null }[];
      lambdaFunctions: {
        codeMatchesRelease: boolean | null;
        functionName: string;
        health: string;
      }[];
    };

    expect(report.ecsServices.map(({ component, health }) => [component, health])).toEqual([
      ["model-runtime", "healthy"],
      ["durable-streams", "unavailable"],
      ["agent-worker", "degraded"],
    ]);
    expect(
      report.lambdaFunctions.map(({ codeMatchesRelease, functionName, health }) => [
        functionName,
        codeMatchesRelease,
        health,
      ]),
    ).toEqual([
      ["api", true, "healthy"],
      ["governance-worker", false, "degraded"],
      ["memory-api", null, "unavailable"],
    ]);
  });

  test("reports every released function within the account's shared Lambda control-plane rate", async () => {
    const released = Array.from({ length: 89 }, (_, index) => ({
      codeSha256: index.toString(16).padStart(64, "0"),
      name: `function-${index}`,
    }));
    const deployed = released.map(({ codeSha256, name }) => ({
      CodeSha256: Buffer.from(codeSha256, "hex").toString("base64"),
      FunctionName: name === "function-88" ? "unrelated" : name,
      LastModified: "2026-10-01T10:00:00.000+0000",
    }));
    let lambdaCalls = 0;
    const lambda = {
      send: async (command: {
        readonly constructor: { readonly name: string };
        readonly input: Readonly<Record<string, unknown>>;
      }) => {
        lambdaCalls += 1;
        if (lambdaCalls > 15) {
          throw Object.assign(new Error("Rate exceeded"), { name: "TooManyRequestsException" });
        }
        const { input } = command;
        switch (command.constructor.name) {
          case "GetFunctionConfigurationCommand": {
            const found = deployed.find(({ FunctionName }) => FunctionName === input.FunctionName);
            if (found) return { ...found, LastUpdateStatus: "Successful", State: "Active" };
            throw Object.assign(new Error("missing"), { name: "ResourceNotFoundException" });
          }
          case "ListFunctionsCommand": {
            const start = Number(input.Marker ?? 0);
            const end = start + Number(input.MaxItems ?? 50);
            return {
              Functions: deployed.slice(start, end),
              ...(end < deployed.length ? { NextMarker: String(end) } : {}),
            };
          }
          default:
            throw new Error(`Unexpected ${command.constructor.name}`);
        }
      },
    };
    const unused = { send: async () => ({}) };
    const service = fakeService({
      installation: {
        ...INSTALLATION,
        lambdaArtifacts: [{ functions: released, name: "platform-api", sha256: "f".repeat(64) }],
      } as Installation,
      readers: makeSystemAwsReaders({
        cloudWatch: unused,
        ecs: { send: async () => ({ services: [] }) },
        lambda,
        secretsManager: unused,
        ssm: unused,
      }),
    });

    const report = (await service("getSystemComponents", operatorRequest())) as {
      lambdaFunctions: { codeMatchesRelease: boolean | null; health: string }[];
    };

    expect(report.lambdaFunctions).toHaveLength(89);
    expect(report.lambdaFunctions.slice(0, 88).every(({ health }) => health === "healthy")).toBe(
      true,
    );
    expect(report.lambdaFunctions[88]).toMatchObject({
      codeMatchesRelease: null,
      health: "unavailable",
    });
  });

  test("lists alarms with the configured prefix, state filter, and continuation token", async () => {
    const requests: unknown[] = [];
    const alarm: AlarmObservation = {
      name: "acme-api-5xx",
      reason: "Threshold crossed",
      state: "ALARM",
      updatedAt: "2026-10-01T11:00:00.000Z",
    };
    const service = fakeService({
      readers: fakeReaders({
        describeAlarms: async (input) => {
          requests.push(input);
          return { alarms: [alarm], nextToken: "token-2" };
        },
      }),
    });

    expect(
      await service(
        "listSystemAlarms",
        operatorRequest({ query: { cursor: "token-1", limit: 25, state: "ALARM" } }),
      ),
    ).toEqual({
      items: [
        {
          metricName: null,
          name: "acme-api-5xx",
          namespace: null,
          reason: "Threshold crossed",
          state: "ALARM",
          updatedAt: "2026-10-01T11:00:00.000Z",
        },
      ],
      nextCursor: "token-2",
    });
    expect(requests).toEqual([
      { maxRecords: 25, namePrefix: "acme-", nextToken: "token-1", state: "ALARM" },
    ]);
  });

  test("treats a placeholder parameter as unconfigured and reports metadata only", async () => {
    const service = fakeService({
      readers: fakeReaders({
        describeSecret: async (reference) =>
          reference.includes(":ssm:")
            ? { kind: "ssm-parameter", lastModifiedAt: "2026-09-01T00:00:00.000Z", version: 1 }
            : {
                currentVersionId: "v-current",
                kind: "secrets-manager",
                lastModifiedAt: "2026-09-02T00:00:00.000Z",
              },
      }),
    });

    expect(await service("listSystemModelProviders", operatorRequest())).toEqual({
      items: [
        {
          configured: false,
          credentialStore: "ssm-parameter",
          lastModifiedAt: "2026-09-01T00:00:00.000Z",
          provider: "openai",
          version: "1",
        },
        {
          configured: true,
          credentialStore: "secrets-manager",
          lastModifiedAt: "2026-09-02T00:00:00.000Z",
          provider: "openrouter",
          version: "v-current",
        },
      ],
    });
  });

  test("lists hosted Bedrock as configured through the task role, with no key metadata", async () => {
    const service = fakeService({
      configuration: { ...CONFIGURATION, bedrockRegion: "us-east-2", modelProviderSecrets: {} },
      readers: fakeReaders({
        describeSecret: async () => {
          throw new Error("Bedrock has no secret to describe.");
        },
      }),
    });

    expect(await service("listSystemModelProviders", operatorRequest())).toEqual({
      items: [
        {
          configured: true,
          credentialStore: "task-role",
          lastModifiedAt: null,
          provider: "bedrock",
          version: null,
        },
      ],
    });
  });

  test("omits model providers the install does not wire", async () => {
    const service = fakeService({
      configuration: {
        ...CONFIGURATION,
        modelProviderSecrets: { openrouter: CONFIGURATION.modelProviderSecrets.openrouter },
      },
      readers: fakeReaders({
        describeSecret: async () => ({
          currentVersionId: "v-current",
          kind: "secrets-manager",
          lastModifiedAt: "2026-09-02T00:00:00.000Z",
        }),
      }),
    });

    expect(await service("listSystemModelProviders", operatorRequest())).toEqual({
      items: [
        {
          configured: true,
          credentialStore: "secrets-manager",
          lastModifiedAt: "2026-09-02T00:00:00.000Z",
          provider: "openrouter",
          version: "v-current",
        },
      ],
    });
  });

  test("returns the installation with its observability data locations", async () => {
    const installation = (await fakeService({ installation: INSTALLATION })(
      "getSystemInstallation",
      operatorRequest(),
    )) as Record<string, unknown>;
    expect(installation).toMatchObject({
      deploymentId: INSTALLATION.deploymentId,
      observability: {
        athenaWorkgroup: CONFIGURATION.observability!.athenaWorkgroup,
        historyRetentionDays: 400,
        hotPlane: { spanRetentionDays: 30, traceRetentionDays: 90 },
        tableBucket: "agent-observability-tables",
        tableNamespace: "agent_observability",
      },
    });
    expect(installation).not.toHaveProperty("createdAt");
  });

  test("distinguishes an unrecorded install from an unconfigured one", async () => {
    expect(fakeService()("getSystemInstallation", operatorRequest())).rejects.toMatchObject({
      code: "installation_not_recorded",
      status: 404,
    });
    expect(
      fakeService({ configuration: undefined })("getSystemComponents", operatorRequest()),
    ).rejects.toMatchObject({ code: "system_operator_unconfigured", status: 503 });
  });
});
