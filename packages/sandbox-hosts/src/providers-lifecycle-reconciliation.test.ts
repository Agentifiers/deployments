import type { Ulid } from "@deployments-ai/db";
import { describe, expect, test } from "bun:test";
import {
  createLambdaMicrovmProvider,
  SandboxCheckpointUnknownError,
  SandboxResumeUnknownError,
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

describe("sandbox provider lifecycle reconciliation", () => {
  test("requires stable running state and control readiness to cancel checkpoint recovery", async () => {
    const commands: string[] = [];
    let getCalls = 0;
    const provider = createLambdaMicrovmProvider({
      client: {
        async send(command) {
          const name = commandName(command) ?? "UnknownCommand";
          commands.push(name);
          if (name === "GetMicrovmCommand") {
            getCalls += 1;
            if (getCalls <= 3) return { state: "RUNNING" };
            return {
              endpoint: "microvm-checkpoint-running.lambda-microvms.aws",
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
      readinessIntervalMs: 1,
      readinessTimeoutMs: 100,
      suspensionIntervalMs: 1,
      suspensionTimeoutMs: 100,
    });
    const checkpointing = {
      ...createInput,
      externalSandboxId: "microvm_checkpoint_stable_running",
      provider: "aws_lambda_microvm" as const,
      status: "checkpointing" as const,
    };

    expect(
      provider.reconcileCheckpoint?.({ lease: checkpointing, requestedAt: 0 }),
    ).resolves.toMatchObject({ lease: { status: "ready" } });
    expect(commands).toEqual([
      "GetMicrovmCommand",
      "GetMicrovmCommand",
      "GetMicrovmCommand",
      "GetMicrovmCommand",
      "CreateMicrovmAuthTokenCommand",
    ]);
  });

  test("keeps a recent running Lambda checkpoint unresolved", async () => {
    const commands: string[] = [];
    const provider = createLambdaMicrovmProvider({
      client: {
        async send(command) {
          const name = commandName(command) ?? "UnknownCommand";
          commands.push(name);
          if (name === "GetMicrovmCommand") return { state: "RUNNING" };
          throw new Error(`Unexpected command ${name}`);
        },
      },
      fetch: async () => {
        throw new Error("readiness must not run while checkpoint request is recent");
      },
      imageIdentifier: "lambda-image",
      suspensionIntervalMs: 1,
      suspensionTimeoutMs: 1_000,
    });
    const checkpointing = {
      ...createInput,
      externalSandboxId: "microvm_checkpoint_recent_running",
      provider: "aws_lambda_microvm" as const,
      status: "checkpointing" as const,
    };

    expect(
      provider.reconcileCheckpoint?.({
        lease: checkpointing,
        requestedAt: Date.now(),
      }),
    ).rejects.toThrow("checkpoint remains running and requires reconciliation");
    expect(commands).toEqual(["GetMicrovmCommand", "GetMicrovmCommand", "GetMicrovmCommand"]);
  });

  test("reconciles an ambiguous Lambda suspend response", async () => {
    const commands: string[] = [];
    let getCalls = 0;
    const provider = createLambdaMicrovmProvider({
      client: {
        async send(command) {
          const name = commandName(command) ?? "UnknownCommand";
          commands.push(name);
          if (name === "SuspendMicrovmCommand") throw new Error("response timeout");
          if (name === "GetMicrovmCommand") {
            getCalls += 1;
            if (getCalls === 1) return { state: "RUNNING" };
            return { state: getCalls === 2 ? "SUSPENDING" : "SUSPENDED" };
          }
          throw new Error(`Unexpected command ${name}`);
        },
      },
      imageIdentifier: "lambda-image",
      now: () => 1_784_524_800_000,
      suspensionIntervalMs: 1,
      suspensionTimeoutMs: 100,
    });
    const lease = {
      ...createInput,
      externalSandboxId: "microvm_suspend_ambiguous",
      provider: "aws_lambda_microvm" as const,
      status: "ready" as const,
    };

    expect(provider.checkpoint({ lease })).resolves.toMatchObject({
      checkpointRef: "lambda-microvm://microvm_suspend_ambiguous/suspended",
    });
    expect(commands).toEqual([
      "SuspendMicrovmCommand",
      "GetMicrovmCommand",
      "GetMicrovmCommand",
      "GetMicrovmCommand",
      "GetMicrovmCommand",
      "GetMicrovmCommand",
    ]);
  });

  test("reconciles stale Lambda states after an ambiguous resume response", async () => {
    const commands: string[] = [];
    let getCalls = 0;
    const provider = createLambdaMicrovmProvider({
      client: {
        async send(command) {
          const name = commandName(command) ?? "UnknownCommand";
          commands.push(name);
          if (name === "ResumeMicrovmCommand") throw new Error("response timeout");
          if (name === "GetMicrovmCommand") {
            getCalls += 1;
            if (getCalls <= 2) return { state: "SUSPENDED" };
            if (getCalls === 3) return { state: "PENDING" };
            if (getCalls === 4) return { state: "RUNNING" };
            return {
              endpoint: "microvm-resume-ambiguous.lambda-microvms.aws",
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
      readinessIntervalMs: 1,
      readinessTimeoutMs: 100,
    });
    const suspended = {
      ...createInput,
      externalSandboxId: "microvm_resume_ambiguous",
      provider: "aws_lambda_microvm" as const,
      status: "suspended" as const,
    };

    expect(provider.resume({ lease: suspended })).resolves.toMatchObject({
      status: "ready",
    });
    expect(commands).toEqual([
      "GetMicrovmCommand",
      "ResumeMicrovmCommand",
      "GetMicrovmCommand",
      "GetMicrovmCommand",
      "GetMicrovmCommand",
      "GetMicrovmCommand",
      "CreateMicrovmAuthTokenCommand",
    ]);
  });

  test("waits for Lambda running state after a successful resume response", async () => {
    const commands: string[] = [];
    let getCalls = 0;
    let resumeDispatches = 0;
    const provider = createLambdaMicrovmProvider({
      client: {
        async send(command) {
          const name = commandName(command) ?? "UnknownCommand";
          commands.push(name);
          if (name === "ResumeMicrovmCommand") return {};
          if (name === "GetMicrovmCommand") {
            getCalls += 1;
            if (getCalls === 1) return { state: "SUSPENDED" };
            if (getCalls === 2) return { state: "PENDING" };
            if (getCalls === 3) return { state: "RUNNING" };
            return {
              endpoint: "microvm-resume-success.lambda-microvms.aws",
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
      readinessIntervalMs: 1,
      readinessTimeoutMs: 100,
    });
    const suspended = {
      ...createInput,
      externalSandboxId: "microvm_resume_success",
      provider: "aws_lambda_microvm" as const,
      status: "suspended" as const,
    };

    expect(
      provider.resume({
        lease: suspended,
        onMutationDispatch: () => {
          resumeDispatches += 1;
        },
      }),
    ).resolves.toMatchObject({ status: "ready" });
    expect(commands).toEqual([
      "GetMicrovmCommand",
      "ResumeMicrovmCommand",
      "GetMicrovmCommand",
      "GetMicrovmCommand",
      "GetMicrovmCommand",
      "CreateMicrovmAuthTokenCommand",
    ]);
    expect(resumeDispatches).toBe(1);
  });

  test("continues polling when Lambda resume is already pending", async () => {
    const commands: string[] = [];
    let getCalls = 0;
    let resumeDispatches = 0;
    const provider = createLambdaMicrovmProvider({
      client: {
        async send(command) {
          const name = commandName(command) ?? "UnknownCommand";
          commands.push(name);
          if (name === "GetMicrovmCommand") {
            getCalls += 1;
            if (getCalls === 1) return { state: "PENDING" };
            if (getCalls === 2) return { state: "RUNNING" };
            return {
              endpoint: "microvm-resume-pending.lambda-microvms.aws",
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
      readinessIntervalMs: 1,
      readinessTimeoutMs: 100,
    });
    const suspended = {
      ...createInput,
      externalSandboxId: "microvm_resume_pending",
      provider: "aws_lambda_microvm" as const,
      status: "suspended" as const,
    };

    expect(
      provider.resume({
        lease: suspended,
        onMutationDispatch: () => {
          resumeDispatches += 1;
        },
      }),
    ).resolves.toMatchObject({ status: "ready" });
    expect(commands).toEqual([
      "GetMicrovmCommand",
      "GetMicrovmCommand",
      "GetMicrovmCommand",
      "CreateMicrovmAuthTokenCommand",
    ]);
    expect(resumeDispatches).toBe(0);
  });

  test("bounds Lambda endpoint discovery during resume", async () => {
    let getCalls = 0;
    const provider = createLambdaMicrovmProvider({
      client: {
        async send(command, options) {
          const name = commandName(command);
          if (name === "ResumeMicrovmCommand") return {};
          if (name === "GetMicrovmCommand") {
            getCalls += 1;
            if (getCalls === 1) return { state: "SUSPENDED" };
            if (getCalls === 2) return { state: "RUNNING" };
            return await new Promise((_resolve, reject) => {
              options?.abortSignal?.addEventListener(
                "abort",
                () => reject(options.abortSignal?.reason),
                { once: true },
              );
            });
          }
          throw new Error(`Unexpected command ${name}`);
        },
      },
      imageIdentifier: "lambda-image",
      readinessIntervalMs: 1,
      readinessTimeoutMs: 10,
    });
    const suspended = {
      ...createInput,
      externalSandboxId: "microvm_endpoint_hung",
      provider: "aws_lambda_microvm" as const,
      status: "suspended" as const,
    };
    const startedAt = Date.now();

    expect(provider.resume({ lease: suspended })).rejects.toBeInstanceOf(SandboxResumeUnknownError);

    expect(Date.now() - startedAt).toBeLessThan(250);
  });

  test("keeps a repeatedly suspended Lambda resume unresolved", async () => {
    const commands: string[] = [];
    const provider = createLambdaMicrovmProvider({
      client: {
        async send(command) {
          const name = commandName(command) ?? "UnknownCommand";
          commands.push(name);
          if (name === "GetMicrovmCommand") return { state: "SUSPENDED" };
          throw new Error(`Unexpected command ${name}`);
        },
      },
      imageIdentifier: "lambda-image",
      readinessIntervalMs: 1,
      readinessTimeoutMs: 100,
    });
    const resuming = {
      ...createInput,
      externalSandboxId: "microvm_resume_not_applied",
      provider: "aws_lambda_microvm" as const,
      status: "resuming" as const,
    };

    expect(provider.reconcileResume?.({ lease: resuming })).rejects.toThrow(
      "resume remains suspended and requires reconciliation",
    );
    expect(commands).toEqual(["GetMicrovmCommand", "GetMicrovmCommand", "GetMicrovmCommand"]);
  });

  test("uses one deadline for the entire Lambda resume operation", async () => {
    let getCalls = 0;
    let resumeSignalAborted = false;
    const provider = createLambdaMicrovmProvider({
      client: {
        async send(command, options) {
          const name = commandName(command);
          if (name === "GetMicrovmCommand") {
            getCalls += 1;
            if (getCalls === 1) {
              await new Promise((resolve) => setTimeout(resolve, 20));
            }
            return { state: "SUSPENDED" };
          }
          if (name === "ResumeMicrovmCommand") {
            return await new Promise((_resolve, reject) => {
              const resetDeadlineGuard = setTimeout(
                () => reject(new Error("resume request exceeded the remaining operation deadline")),
                20,
              );
              options?.abortSignal?.addEventListener(
                "abort",
                () => {
                  clearTimeout(resetDeadlineGuard);
                  resumeSignalAborted = true;
                  reject(options.abortSignal?.reason);
                },
                { once: true },
              );
            });
          }
          throw new Error(`Unexpected command ${name}`);
        },
      },
      imageIdentifier: "lambda-image",
      readinessIntervalMs: 1,
      readinessTimeoutMs: 30,
    });
    const suspended = {
      ...createInput,
      externalSandboxId: "microvm_resume_deadline",
      provider: "aws_lambda_microvm" as const,
      status: "suspended" as const,
    };

    expect(provider.resume({ lease: suspended })).rejects.toBeInstanceOf(SandboxResumeUnknownError);

    expect(resumeSignalAborted).toBe(true);
  });

  test("does not reconcile deterministic Lambda resume rejections as active", async () => {
    const commands: string[] = [];
    const provider = createLambdaMicrovmProvider({
      client: {
        async send(command) {
          const name = commandName(command) ?? "UnknownCommand";
          commands.push(name);
          if (name === "GetMicrovmCommand") return { state: "SUSPENDED" };
          if (name === "ResumeMicrovmCommand") {
            throw Object.assign(new Error("resume denied"), {
              $fault: "client",
              $metadata: { httpStatusCode: 403 },
            });
          }
          throw new Error(`Unexpected command ${name}`);
        },
      },
      imageIdentifier: "lambda-image",
      readinessIntervalMs: 1,
      readinessTimeoutMs: 10,
    });
    const suspended = {
      ...createInput,
      externalSandboxId: "microvm_resume_denied",
      provider: "aws_lambda_microvm" as const,
      status: "suspended" as const,
    };

    expect(provider.resume({ lease: suspended })).rejects.toThrow("resume denied");
    expect(commands).toEqual(["GetMicrovmCommand", "ResumeMicrovmCommand"]);
  });

  test("reconciles Lambda resume state conflicts as potentially already running", async () => {
    const commands: string[] = [];
    let getCalls = 0;
    const provider = createLambdaMicrovmProvider({
      client: {
        async send(command) {
          const name = commandName(command) ?? "UnknownCommand";
          commands.push(name);
          if (name === "GetMicrovmCommand") {
            getCalls += 1;
            return getCalls === 1
              ? { state: "SUSPENDED" }
              : {
                  endpoint: "microvm-conflict.lambda-microvms.aws",
                  state: "RUNNING",
                };
          }
          if (name === "ResumeMicrovmCommand") {
            throw Object.assign(new Error("state conflict"), {
              $fault: "client",
              $metadata: { httpStatusCode: 409 },
            });
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
    });
    const suspended = {
      ...createInput,
      externalSandboxId: "microvm_resume_conflict",
      provider: "aws_lambda_microvm" as const,
      status: "suspended" as const,
    };

    expect(provider.resume({ lease: suspended })).resolves.toMatchObject({
      status: "ready",
    });
    expect(commands).toEqual([
      "GetMicrovmCommand",
      "ResumeMicrovmCommand",
      "GetMicrovmCommand",
      "GetMicrovmCommand",
      "CreateMicrovmAuthTokenCommand",
    ]);
  });

  test("continues Lambda readiness when a prior resume already reached running", async () => {
    const commands: string[] = [];
    let getCalls = 0;
    const provider = createLambdaMicrovmProvider({
      client: {
        async send(command) {
          const name = commandName(command) ?? "UnknownCommand";
          commands.push(name);
          if (name === "GetMicrovmCommand") {
            getCalls += 1;
            if (getCalls === 1) return { state: "SUSPENDED" };
            if (getCalls === 2) throw new Error("endpoint lookup timed out");
            if (getCalls === 3) return { state: "RUNNING" };
            return {
              endpoint: "microvm-resumed.lambda-microvms.aws",
              state: "RUNNING",
            };
          }
          if (name === "ResumeMicrovmCommand") return {};
          if (name === "CreateMicrovmAuthTokenCommand") {
            return { authToken: { "X-aws-proxy-auth": "proxy-token" } };
          }
          throw new Error(`Unexpected command ${name}`);
        },
      },
      fetch: async () => new Response(null, { status: 204 }),
      imageIdentifier: "lambda-image",
      readinessTimeoutMs: 100,
    });
    const suspended = {
      ...createInput,
      externalSandboxId: "microvm_resumed",
      provider: "aws_lambda_microvm" as const,
      status: "suspended" as const,
    };

    expect(provider.resume({ lease: suspended })).rejects.toThrow(
      "Sandbox resume may have reached running state",
    );
    expect(provider.resume({ lease: suspended })).resolves.toMatchObject({
      status: "ready",
    });
    expect(commands).toEqual([
      "GetMicrovmCommand",
      "ResumeMicrovmCommand",
      "GetMicrovmCommand",
      "GetMicrovmCommand",
      "GetMicrovmCommand",
      "CreateMicrovmAuthTokenCommand",
    ]);
  });

  test("aborts hung Lambda suspension polling at the configured deadline", async () => {
    const provider = createLambdaMicrovmProvider({
      client: {
        async send(command, options) {
          const name = commandName(command);
          if (name === "RunMicrovmCommand") {
            return lambdaRunResult("microvm-hung-suspend.lambda-microvms.aws", "microvm_hs");
          }
          if (name === "CreateMicrovmAuthTokenCommand") {
            return { authToken: { "X-aws-proxy-auth": "proxy-token" } };
          }
          if (name === "SuspendMicrovmCommand") return {};
          if (name === "GetMicrovmCommand") {
            return await new Promise((_resolve, reject) => {
              options?.abortSignal?.addEventListener(
                "abort",
                () => reject(options.abortSignal?.reason),
                { once: true },
              );
            });
          }
          throw new Error(`Unexpected command ${name}`);
        },
      },
      fetch: async () => new Response(null, { status: 204 }),
      imageIdentifier: "lambda-image",
      readinessTimeoutMs: 100,
      suspensionIntervalMs: 1,
      suspensionTimeoutMs: 10,
    });
    const lease = await provider.create(createInput);

    expect(provider.checkpoint({ lease })).rejects.toBeInstanceOf(SandboxCheckpointUnknownError);
  });

  test("does not sleep past the Lambda suspension deadline", async () => {
    const provider = createLambdaMicrovmProvider({
      client: {
        async send(command) {
          const name = commandName(command);
          if (name === "RunMicrovmCommand") {
            return lambdaRunResult(
              "microvm-suspension-deadline.lambda-microvms.aws",
              "microvm_suspension_deadline",
            );
          }
          if (name === "CreateMicrovmAuthTokenCommand") {
            return { authToken: { "X-aws-proxy-auth": "proxy-token" } };
          }
          if (name === "SuspendMicrovmCommand") return {};
          if (name === "GetMicrovmCommand") return { state: "SUSPENDING" };
          throw new Error(`Unexpected command ${name}`);
        },
      },
      fetch: async () => new Response(null, { status: 204 }),
      imageIdentifier: "lambda-image",
      readinessTimeoutMs: 100,
      suspensionIntervalMs: 1_000,
      suspensionTimeoutMs: 10,
    });
    const lease = await provider.create(createInput);
    const startedAt = Date.now();

    expect(provider.checkpoint({ lease })).rejects.toBeDefined();

    expect(Date.now() - startedAt).toBeLessThan(250);
  });
});
