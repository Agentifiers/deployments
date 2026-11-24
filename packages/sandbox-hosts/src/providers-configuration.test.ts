import type { Ulid } from "@deployments-ai/db";
import { describe, expect, test } from "bun:test";
import {
  createLambdaMicrovmProvider,
  createSandboxProvider,
  resolveSandboxResourceProfile,
  resolveSandboxProviderConfigFromEnv,
  resolveSandboxUsageCostPolicyFromEnv,
  SANDBOX_USAGE_COST_POLICY_ENV,
} from "./index.ts";

const ORGANIZATION_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV" as Ulid;
const PROJECT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAW" as Ulid;
const ENVIRONMENT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAX" as Ulid;
const AGENT_DEPLOYMENT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAY" as Ulid;
const RUN_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAZ" as Ulid;
const ALLOCATION_ID = "01ARZ3NDEKTSV4RRFFQ69G5FB0" as Ulid;
const WORKSPACE_ID = "01ARZ3NDEKTSV4RRFFQ69G5FB1" as Ulid;

const createInput = {
  executionTargetId: AGENT_DEPLOYMENT_ID,
  executionTargetKind: "agent-deployment" as const,
  allocationId: ALLOCATION_ID,
  environmentId: ENVIRONMENT_ID,
  isolationMode: "run-ephemeral" as const,
  organizationId: ORGANIZATION_ID,
  projectId: PROJECT_ID,
  runId: RUN_ID,
  workspaceId: WORKSPACE_ID,
};

function commandName(command: unknown) {
  return (command as { constructor?: { name?: string } }).constructor?.name;
}

describe("sandbox provider configuration", () => {
  test("treats missing Lambda MicroVMs as already destroyed", async () => {
    const provider = createLambdaMicrovmProvider({
      client: {
        async send(command) {
          if (commandName(command) === "TerminateMicrovmCommand") {
            throw { name: "ResourceNotFoundException" };
          }
          throw new Error(`Unexpected command ${commandName(command)}`);
        },
      },
      imageIdentifier: "lambda-image",
      readinessTimeoutMs: 1,
    });
    const lease = {
      ...createInput,
      externalSandboxId: "microvm_missing",
      provider: "aws_lambda_microvm" as const,
      status: "ready" as const,
    };

    expect(provider.destroy({ lease })).resolves.toBeUndefined();
  });

  test("defaults to Lambda and rejects unknown provider modes", async () => {
    expect(createSandboxProvider().create(createInput)).rejects.toThrow(
      "Lambda MicroVM provider is not configured",
    );
    expect(() => createSandboxProvider({ mode: "aws_ec2" })).toThrow(
      "Unknown sandbox provider mode: aws_ec2",
    );
  });

  test("resolves canonical and legacy environment aliases", () => {
    const config = resolveSandboxProviderConfigFromEnv({
      AGENT_SANDBOX_PROVIDER: "aws_lambda_microvm",
      LAMBDA_MICROVM_IMAGE_IDENTIFIER: "arn:aws:lambda:us-east-2:123456789012:microvm-image/agent",
      LAMBDA_MICROVM_IMAGE_MEMORY_MIB: "4096",
      LAMBDA_MICROVM_IMAGE_VCPU: "0.5",
      LAMBDA_MICROVM_RECONCILIATION_TARGET: "123456789012:us-east-2",
      LAMBDA_MICROVM_REQUEST_TIMEOUT_MS: "30000",
    });

    expect(config.mode).toBe("aws_lambda_microvm");
    expect(config.lambdaMicrovm).toMatchObject({
      imageIdentifier: "arn:aws:lambda:us-east-2:123456789012:microvm-image/agent",
      imageMemoryMiB: 4_096,
      imageVcpu: 0.5,
      reconciliationTarget: "123456789012:us-east-2",
      requestTimeoutMs: 30_000,
    });
    expect(config.lambdaMicrovm?.region).toBeUndefined();
    expect(config.lambdaMicrovm?.logging).toBeUndefined();
  });

  test("sends runtime logs to the configured log group under the execution role", () => {
    const config = resolveSandboxProviderConfigFromEnv({
      DEPLOYMENTS_AI_LAMBDA_MICROVM_EXECUTION_ROLE_ARN:
        "arn:aws:iam::123456789012:role/microvm-execution",
      DEPLOYMENTS_AI_LAMBDA_MICROVM_LOG_GROUP: "/aws/lambda-microvms/deployments-ai-sandbox",
    });

    expect(config.lambdaMicrovm).toMatchObject({
      executionRoleArn: "arn:aws:iam::123456789012:role/microvm-execution",
      logging: { cloudWatch: { logGroup: "/aws/lambda-microvms/deployments-ai-sandbox" } },
    });
  });

  test("rejects partially parsed integer environment values", () => {
    for (const value of ["60000ms", "1.5", "Infinity"]) {
      expect(() =>
        resolveSandboxProviderConfigFromEnv({
          LAMBDA_MICROVM_REQUEST_TIMEOUT_MS: value,
        }),
      ).toThrow("DEPLOYMENTS_AI_LAMBDA_MICROVM_REQUEST_TIMEOUT_MS must be a positive integer");
    }
    expect(
      resolveSandboxProviderConfigFromEnv({
        LAMBDA_MICROVM_REQUEST_TIMEOUT_MS: "1e3",
      }).lambdaMicrovm?.requestTimeoutMs,
    ).toBe(1_000);
  });

  test("rejects inherited object properties as sandbox resource profiles", () => {
    for (const profile of ["constructor", "toString", "__proto__"]) {
      expect(() => resolveSandboxResourceProfile(profile)).toThrow(
        `Unknown sandbox resource profile: ${profile}`,
      );
    }
  });

  test("rejects automatic Lambda idle transitions in managed configuration", () => {
    expect(() =>
      resolveSandboxProviderConfigFromEnv({
        LAMBDA_MICROVM_AUTO_RESUME: "true",
        LAMBDA_MICROVM_IDLE_MAX_SECONDS: "900",
        LAMBDA_MICROVM_SUSPENDED_DURATION_SECONDS: "900",
      }),
    ).toThrow("Automatic Lambda MicroVM idle transitions are unsupported");
  });
});

describe("sandbox usage cost policy configuration", () => {
  test("reads the install's hourly rates and leaves an unset policy undefined", () => {
    expect(resolveSandboxUsageCostPolicyFromEnv({})).toBeUndefined();
    expect(resolveSandboxUsageCostPolicyFromEnv({ [SANDBOX_USAGE_COST_POLICY_ENV]: " " })).toBe(
      undefined,
    );
    expect(
      resolveSandboxUsageCostPolicyFromEnv({
        [SANDBOX_USAGE_COST_POLICY_ENV]:
          '{"baseHourUsdMicros":0,"memoryGiBHourUsdMicros":13200,"vcpuHourUsdMicros":99700}',
      }),
    ).toEqual({ baseHourUsdMicros: 0, memoryGiBHourUsdMicros: 13_200, vcpuHourUsdMicros: 99_700 });
  });

  test.each(["99700", "[]", "null", '{"vcpuHourUsdMicro":99700}', '{"vcpuHourUsdMicros":"99700"}'])(
    "rejects the policy %s",
    (encoded) => {
      expect(() =>
        resolveSandboxUsageCostPolicyFromEnv({ [SANDBOX_USAGE_COST_POLICY_ENV]: encoded }),
      ).toThrow(
        "DEPLOYMENTS_AI_SANDBOX_USAGE_COST_POLICY must be a JSON object of USD-micro hourly rates named baseHourUsdMicros, memoryGiBHourUsdMicros, vcpuHourUsdMicros.",
      );
    },
  );
});
