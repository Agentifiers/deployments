import type { Ulid } from "@deployments-ai/db";
import { describe, expect, test } from "bun:test";
import {
  createLambdaMicrovmProvider,
  MAX_SANDBOX_RESERVED_MEMORY_MIB,
  MAX_SANDBOX_RESERVED_VCPU,
  SandboxCheckpointUnknownError,
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

function lambdaRunResult(endpoint: string, microvmId: string, maximumDurationInSeconds = 28_800) {
  return {
    endpoint,
    maximumDurationInSeconds,
    microvmId,
    startedAt: new Date("2026-07-21T00:00:00.000Z"),
  };
}

describe("sandbox provider routing and checkpointing", () => {
  test("rejects provider operations after a route changes", async () => {
    const lambdaA = createLambdaMicrovmProvider({
      client: {
        async send(command) {
          if (commandName(command) === "RunMicrovmCommand") {
            return lambdaRunResult("route-a.lambda-microvms.aws", "microvm_route");
          }
          if (commandName(command) === "CreateMicrovmAuthTokenCommand") {
            return { authToken: { "X-aws-proxy-auth": "proxy-token" } };
          }
          throw new Error(`Unexpected command ${commandName(command)}`);
        },
      },
      fetch: async () => new Response(null, { status: 204 }),
      imageIdentifier: "lambda-image",
      reconciliationTarget: "route-a",
    });
    const lambdaLease = await lambdaA.create(createInput);
    let lambdaCalls = 0;
    const lambdaB = createLambdaMicrovmProvider({
      client: {
        async send() {
          lambdaCalls += 1;
          return {};
        },
      },
      imageIdentifier: "lambda-image",
      reconciliationTarget: "route-b",
    });
    expect(lambdaB.destroy({ lease: lambdaLease })).rejects.toThrow("different provider route");
    expect(lambdaCalls).toBe(0);
  });

  test("derives stable Lambda route identity from AWS account and region", () => {
    const lease = {
      ...createInput,
      externalSandboxId: "microvm_route_scope",
      provider: "aws_lambda_microvm" as const,
      status: "creating" as const,
    };
    const routeKey = (imageIdentifier: string) =>
      createLambdaMicrovmProvider({
        imageIdentifier,
      }).providerRouteKeyForLease?.(lease);
    const accountAImage = "arn:aws:lambda:us-east-2:123456789012:microvm-image/agent-runtime";
    const accountBImage = "arn:aws:lambda:us-east-2:210987654321:microvm-image/agent-runtime";

    expect(routeKey(accountAImage)).toBe(routeKey(accountAImage));
    expect(routeKey(accountBImage)).not.toBe(routeKey(accountAImage));
    expect(() =>
      createLambdaMicrovmProvider({
        executionRoleArn: "arn:aws:iam::210987654321:role/microvm-execution",
        imageIdentifier: accountAImage,
      }),
    ).toThrow("image and execution role must use the same AWS account");
  });

  test("persists the effective Lambda region inferred from the image ARN", async () => {
    const provider = createLambdaMicrovmProvider({
      client: {
        async send(command) {
          if (commandName(command) === "RunMicrovmCommand") {
            return lambdaRunResult(
              "microvm-effective-region.lambda-microvms.aws",
              "microvm_effective_region",
            );
          }
          if (commandName(command) === "CreateMicrovmAuthTokenCommand") {
            return { authToken: { "X-aws-proxy-auth": "proxy-token" } };
          }
          throw new Error(`Unexpected command ${commandName(command)}`);
        },
      },
      fetch: async () => new Response(null, { status: 204 }),
      imageIdentifier: "arn:aws:lambda:us-west-2:123456789012:microvm-image/agent-runtime",
      readinessTimeoutMs: 100,
    });

    expect(provider.create(createInput)).resolves.toMatchObject({
      region: "us-west-2",
    });
  });

  test("validates recovered Lambda leases through state and control readiness", async () => {
    const commands: string[] = [];
    const provider = createLambdaMicrovmProvider({
      client: {
        async send(command) {
          const name = commandName(command) ?? "UnknownCommand";
          commands.push(name);
          if (name === "GetMicrovmCommand") {
            return {
              endpoint: "microvm-recovered.lambda-microvms.aws",
              state: "RUNNING",
            };
          }
          if (name === "CreateMicrovmAuthTokenCommand") {
            return { authToken: { "X-aws-proxy-auth": "proxy-token" } };
          }
          throw new Error(`Unexpected command ${name}`);
        },
      },
      fetch: async () => new Response(null, { status: 204 }),
      imageIdentifier: "lambda-image",
      readinessTimeoutMs: 100,
      reconciliationTarget: "lambda-recovered",
    });
    const recovered = {
      ...createInput,
      externalSandboxId: "microvm_recovered",
      provider: "aws_lambda_microvm" as const,
      status: "creating" as const,
    };

    expect(provider.validateReadyLease?.(recovered)).resolves.toMatchObject({
      externalSandboxId: "microvm_recovered",
      status: "ready",
    });
    expect(commands).toEqual([
      "GetMicrovmCommand",
      "GetMicrovmCommand",
      "CreateMicrovmAuthTokenCommand",
    ]);
  });

  test("verifies the exact Lambda request against the persisted fingerprint", async () => {
    let hookCalls = 0;
    let runCalls = 0;
    const provider = createLambdaMicrovmProvider({
      client: {
        async send() {
          runCalls += 1;
          throw new Error("not reached");
        },
      },
      imageIdentifier: "lambda-image",
      runHookPayload: () => `payload-${(hookCalls += 1)}`,
    });
    const fingerprint = provider.allocationFingerprint?.(createInput);

    expect(
      provider.create({
        ...createInput,
        ...(fingerprint ? { expectedAllocationFingerprint: fingerprint } : {}),
      }),
    ).rejects.toThrow("allocation configuration fingerprint changed");
    expect(hookCalls).toBe(2);
    expect(runCalls).toBe(0);
  });

  test("fingerprints the effective Lambda SDK region and endpoint", () => {
    const fingerprint = (region: string, endpoint: string) =>
      createLambdaMicrovmProvider({
        clientConfig: { endpoint, region },
        imageIdentifier: "lambda-image",
      }).allocationFingerprint?.(createInput);

    const baseline = fingerprint("us-east-1", "https://lambda-microvms.us-east-1.amazonaws.com");

    expect(fingerprint("us-west-2", "https://lambda-microvms.us-east-1.amazonaws.com")).not.toBe(
      baseline,
    );
    expect(fingerprint("us-east-1", "https://lambda-microvms.example.com")).not.toBe(baseline);
    expect(
      createLambdaMicrovmProvider({
        clientConfig: {
          endpoint: "https://lambda-microvms.us-east-1.amazonaws.com",
          region: "us-east-1",
        },
        imageIdentifier: "lambda-image",
        readinessPath: "/ready",
      }).allocationFingerprint?.(createInput),
    ).not.toBe(baseline);
  });

  test("meters configured Lambda image capacity and rejects unsupported minima", async () => {
    let runCalls = 0;
    const provider = createLambdaMicrovmProvider({
      client: {
        async send(command) {
          if (commandName(command) === "CreateMicrovmAuthTokenCommand") {
            return { authToken: { "X-aws-proxy-auth": "proxy-token" } };
          }
          if (commandName(command) !== "RunMicrovmCommand") {
            throw new Error(`Unexpected command ${commandName(command)}`);
          }
          runCalls += 1;
          return lambdaRunResult("microvm-capacity.lambda-microvms.aws", "microvm_capacity");
        },
      },
      fetch: async () => new Response(null, { status: 204 }),
      imageIdentifier: "lambda-image",
      imageMemoryMiB: 4_096,
      imageVcpu: 2,
      readinessTimeoutMs: 100,
    });

    expect(provider.create({ ...createInput, minMemoryMiB: 8_192 })).rejects.toThrow(
      "Lambda MicroVM image capacity is 2 vCPU and 4096 MiB",
    );
    const lease = await provider.create({
      ...createInput,
      minMemoryMiB: 1_024,
      minVcpu: 1,
    });

    expect(runCalls).toBe(1);
    expect(lease).toMatchObject({ reservedMemoryMiB: 4_096, reservedVcpu: 2 });
  });

  test("rejects a mismatched Lambda image before allocation", async () => {
    const commands: unknown[] = [];
    const provider = createLambdaMicrovmProvider({
      client: {
        async send(command) {
          commands.push(command);
          throw new Error("not reached");
        },
      },
      imageIdentifier: "lambda-image",
      imageVersion: "7",
    });

    expect(() =>
      provider.allocationFingerprint?.({
        ...createInput,
        imageRef: "other-image@1",
      }),
    ).toThrow("Lambda MicroVM provider is configured for image lambda-image@7, not other-image@1");
    expect(provider.create({ ...createInput, imageRef: "other-image@1" })).rejects.toThrow(
      "Lambda MicroVM provider is configured for image lambda-image@7, not other-image@1",
    );
    expect(commands).toHaveLength(0);
  });

  test("validates Lambda control token settings before allocation", () => {
    expect(() =>
      createLambdaMicrovmProvider({
        imageIdentifier: "lambda-image",
        readinessTimeoutMs: 0,
      }),
    ).toThrow("readinessTimeoutMs must be a positive integer");
    expect(() =>
      createLambdaMicrovmProvider({
        controlPort: 65_536,
        imageIdentifier: "lambda-image",
      }),
    ).toThrow("controlPort must be an integer from 1 through 65535");
    expect(() =>
      createLambdaMicrovmProvider({
        authTokenTtlMinutes: 61,
        imageIdentifier: "lambda-image",
      }),
    ).toThrow("authTokenTtlMinutes must be an integer from 1 through 60");
    expect(() =>
      createLambdaMicrovmProvider({
        idlePolicy: {
          autoResumeEnabled: true,
          maxIdleDurationSeconds: 900,
          suspendedDurationSeconds: 900,
        },
        imageIdentifier: "lambda-image",
      }),
    ).toThrow("idlePolicy is unsupported until lifecycle reconciliation is enabled");
    expect(() =>
      createLambdaMicrovmProvider({
        imageIdentifier: "lambda-image",
        maximumDurationInSeconds: 28_801,
      }),
    ).toThrow("maximumDurationInSeconds must be an integer from 1 through 28800");
    expect(() =>
      createLambdaMicrovmProvider({
        imageIdentifier: "lambda-image",
        imageMemoryMiB: MAX_SANDBOX_RESERVED_MEMORY_MIB + 1,
      }),
    ).toThrow("imageMemoryMiB must be a positive finite number no greater than");
    expect(() =>
      createLambdaMicrovmProvider({
        imageIdentifier: "lambda-image",
        imageVcpu: MAX_SANDBOX_RESERVED_VCPU + 1,
      }),
    ).toThrow("imageVcpu must be a positive finite number no greater than");
  });

  test("waits for Lambda MicroVM suspension before returning a checkpoint", async () => {
    let clock = 0;
    const commands: string[] = [];
    let getCalls = 0;
    const provider = createLambdaMicrovmProvider({
      client: {
        async send(command) {
          const name = commandName(command) ?? "UnknownCommand";
          commands.push(name);
          if (name === "RunMicrovmCommand") {
            return lambdaRunResult("microvm-checkpoint.lambda-microvms.aws", "microvm_cp");
          }
          if (name === "CreateMicrovmAuthTokenCommand") {
            return { authToken: { "X-aws-proxy-auth": "proxy-token" } };
          }
          if (name === "SuspendMicrovmCommand") return {};
          if (name === "GetMicrovmCommand") {
            clock += 100;
            getCalls += 1;
            return { state: getCalls === 1 ? "SUSPENDING" : "SUSPENDED" };
          }
          throw new Error(`Unexpected command ${name}`);
        },
      },
      fetch: async () => new Response(null, { status: 204 }),
      imageIdentifier: "lambda-image",
      now: () => clock,
      readinessTimeoutMs: 100,
      suspensionIntervalMs: 1,
      suspensionTimeoutMs: 100,
    });
    const lease = await provider.create(createInput);

    expect(provider.checkpoint({ lease })).resolves.toMatchObject({
      checkpointRef: "lambda-microvm://microvm_cp/suspended",
      createdAt: 200,
    });
    expect(commands).toEqual([
      "RunMicrovmCommand",
      "CreateMicrovmAuthTokenCommand",
      "SuspendMicrovmCommand",
      "GetMicrovmCommand",
      "GetMicrovmCommand",
      "GetMicrovmCommand",
      "GetMicrovmCommand",
    ]);
  });

  test("retries transient Lambda suspension polling failures", async () => {
    let getCalls = 0;
    const provider = createLambdaMicrovmProvider({
      client: {
        async send(command) {
          const name = commandName(command);
          if (name === "SuspendMicrovmCommand") return {};
          if (name === "GetMicrovmCommand") {
            getCalls += 1;
            if (getCalls === 1) throw new Error("transient get failure");
            return { state: "SUSPENDED" };
          }
          throw new Error(`Unexpected command ${name}`);
        },
      },
      imageIdentifier: "lambda-image",
      suspensionIntervalMs: 1,
      suspensionTimeoutMs: 100,
    });
    const lease = {
      ...createInput,
      externalSandboxId: "microvm_suspend_transient",
      provider: "aws_lambda_microvm" as const,
      status: "ready" as const,
    };

    expect(provider.checkpoint({ lease })).resolves.toMatchObject({
      checkpointRef: "lambda-microvm://microvm_suspend_transient/suspended",
    });
    expect(getCalls).toBe(4);
  });

  test("classifies cancellation after Lambda suspend dispatch as an unknown checkpoint", async () => {
    const controller = new AbortController();
    const provider = createLambdaMicrovmProvider({
      client: {
        async send(command) {
          const name = commandName(command);
          if (name === "SuspendMicrovmCommand") {
            controller.abort(new Error("caller canceled after suspend"));
            return {};
          }
          if (name === "GetMicrovmCommand") return { state: "SUSPENDING" };
          throw new Error(`Unexpected command ${name}`);
        },
      },
      imageIdentifier: "lambda-image",
      suspensionIntervalMs: 1,
      suspensionTimeoutMs: 100,
    });
    const lease = {
      ...createInput,
      externalSandboxId: "microvm_suspend_canceled",
      provider: "aws_lambda_microvm" as const,
      status: "ready" as const,
    };

    expect(provider.checkpoint({ lease, signal: controller.signal })).rejects.toBeInstanceOf(
      SandboxCheckpointUnknownError,
    );
  });

  test("does not classify deterministic Lambda suspend rejection as ambiguous", async () => {
    let getCalls = 0;
    const denied = Object.assign(new Error("suspend denied"), {
      $fault: "client",
      $metadata: { httpStatusCode: 403 },
    });
    const provider = createLambdaMicrovmProvider({
      client: {
        async send(command) {
          const name = commandName(command);
          if (name === "SuspendMicrovmCommand") throw denied;
          if (name === "GetMicrovmCommand") getCalls += 1;
          throw new Error(`Unexpected command ${name}`);
        },
      },
      imageIdentifier: "lambda-image",
    });
    const lease = {
      ...createInput,
      externalSandboxId: "microvm_suspend_denied",
      provider: "aws_lambda_microvm" as const,
      status: "ready" as const,
    };

    expect(provider.checkpoint({ lease })).rejects.toBe(denied);
    expect(getCalls).toBe(0);
  });

  test("reconciles Lambda checkpoint state without replaying suspend", async () => {
    const commands: string[] = [];
    let getCalls = 0;
    const provider = createLambdaMicrovmProvider({
      client: {
        async send(command) {
          const name = commandName(command) ?? "UnknownCommand";
          commands.push(name);
          if (name === "GetMicrovmCommand") {
            getCalls += 1;
            return { state: getCalls === 1 ? "SUSPENDING" : "SUSPENDED" };
          }
          throw new Error(`Unexpected command ${name}`);
        },
      },
      imageIdentifier: "lambda-image",
      suspensionIntervalMs: 1,
      suspensionTimeoutMs: 100,
    });
    const checkpointing = {
      ...createInput,
      externalSandboxId: "microvm_checkpoint_reconcile",
      provider: "aws_lambda_microvm" as const,
      status: "checkpointing" as const,
    };

    expect(provider.reconcileCheckpoint?.({ lease: checkpointing })).resolves.toMatchObject({
      checkpoint: {
        checkpointRef: "lambda-microvm://microvm_checkpoint_reconcile/suspended",
      },
      lease: { status: "suspended" },
    });
    expect(commands).toEqual([
      "GetMicrovmCommand",
      "GetMicrovmCommand",
      "GetMicrovmCommand",
      "GetMicrovmCommand",
    ]);
  });

  test("rejects one stale suspended read during checkpoint reconciliation", async () => {
    let getCalls = 0;
    const provider = createLambdaMicrovmProvider({
      client: {
        async send(command) {
          if (commandName(command) !== "GetMicrovmCommand") {
            throw new Error(`Unexpected command ${commandName(command)}`);
          }
          getCalls += 1;
          return { state: getCalls === 1 ? "SUSPENDED" : "RUNNING" };
        },
      },
      imageIdentifier: "lambda-image",
      suspensionIntervalMs: 1,
      suspensionTimeoutMs: 100,
    });
    const checkpointing = {
      ...createInput,
      externalSandboxId: "microvm_checkpoint_stale_suspended",
      provider: "aws_lambda_microvm" as const,
      status: "checkpointing" as const,
    };

    expect(provider.reconcileCheckpoint?.({ lease: checkpointing })).rejects.toThrow(
      "suspended state was not stable",
    );
    expect(getCalls).toBe(2);
  });

  test("does not trust one stale running read during checkpoint reconciliation", async () => {
    const commands: string[] = [];
    let getCalls = 0;
    const provider = createLambdaMicrovmProvider({
      client: {
        async send(command) {
          const name = commandName(command) ?? "UnknownCommand";
          commands.push(name);
          if (name === "GetMicrovmCommand") {
            getCalls += 1;
            if (getCalls === 1) return { state: "RUNNING" };
            if (getCalls === 2) return { state: "SUSPENDING" };
            return { state: "SUSPENDED" };
          }
          throw new Error(`Unexpected command ${name}`);
        },
      },
      imageIdentifier: "lambda-image",
      suspensionIntervalMs: 1,
      suspensionTimeoutMs: 100,
    });
    const checkpointing = {
      ...createInput,
      externalSandboxId: "microvm_checkpoint_stale_running",
      provider: "aws_lambda_microvm" as const,
      status: "checkpointing" as const,
    };

    expect(
      provider.reconcileCheckpoint?.({
        lease: checkpointing,
        requestedAt: 1_000,
      }),
    ).resolves.toMatchObject({
      checkpoint: { createdAt: 1_000 },
      lease: { status: "suspended" },
    });
    expect(commands).toEqual([
      "GetMicrovmCommand",
      "GetMicrovmCommand",
      "GetMicrovmCommand",
      "GetMicrovmCommand",
      "GetMicrovmCommand",
    ]);
  });
});
