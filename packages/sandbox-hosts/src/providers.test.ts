import type { Ulid } from "@deployments-ai/db";
import { describe, expect, test } from "bun:test";
import {
  createLambdaMicrovmProvider,
  SandboxAllocationUnknownError,
  SandboxDataPlaneUnknownError,
  SandboxDestroyUnknownError,
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

function commandInput(command: unknown) {
  return (command as { input?: unknown }).input;
}

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status: 200,
    ...init,
  });
}

function lambdaProviderClient(endpoint: string) {
  return {
    async send(command: unknown) {
      if (commandName(command) === "GetMicrovmCommand") return { endpoint };
      if (commandName(command) === "CreateMicrovmAuthTokenCommand") {
        return { authToken: { "X-aws-proxy-auth": "proxy-token" } };
      }
      throw new Error(`Unexpected command ${commandName(command)}`);
    },
  };
}

describe("sandbox providers", () => {
  test("runs Lambda MicroVM sandboxes through the in-VM control service", async () => {
    const commands: unknown[] = [];
    const requests: string[] = [];
    const redirects: Array<RequestInit["redirect"]> = [];
    const startedAt = new Date("2026-07-21T00:00:00.000Z");
    const provider = createLambdaMicrovmProvider({
      client: {
        async send(command) {
          if (commandName(command) === "CreateMicrovmAuthTokenCommand") {
            return { authToken: { "X-aws-proxy-auth": "proxy-token" } };
          }
          commands.push(command);
          if (commandName(command) === "RunMicrovmCommand") {
            return {
              endpoint: "microvm-1.lambda-microvms.aws",
              maximumDurationInSeconds: 3_600,
              microvmId: "microvm_1",
              startedAt,
            };
          }
          if (commandName(command) === "CreateMicrovmAuthTokenCommand") {
            return { authToken: { "X-aws-proxy-auth": "proxy-token" } };
          }
          if (
            commandName(command) === "SuspendMicrovmCommand" ||
            commandName(command) === "TerminateMicrovmCommand"
          ) {
            return {};
          }
          throw new Error(`Unexpected command ${commandName(command)}`);
        },
      },
      fetch: async (input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        requests.push(`${init?.method ?? "GET"} ${url}`);
        redirects.push(init?.redirect);
        if (url.endsWith("/health")) return jsonResponse({ ok: true });
        if (url.endsWith("/exec")) {
          return jsonResponse({
            durationMs: 12,
            exitCode: 0,
            stderr: "",
            stdout: "ok\n",
          });
        }
        return new Response(null, { status: 204 });
      },
      imageIdentifier: "arn:aws:lambda:us-east-2:123456789012:microvm-image/agent",
      imageMemoryMiB: 4_096,
      imageVersion: "7",
      imageVcpu: 2,
      maximumDurationInSeconds: 3_600,
      now: () => startedAt.getTime() + 60_000,
      readinessTimeoutMs: 100,
      region: "us-east-2",
    });

    const lease = await provider.create({
      ...createInput,
      minMemoryMiB: 4_096,
      minVcpu: 2,
    });
    expect(provider.exec({ command: ["pwd"], lease })).resolves.toMatchObject({
      exitCode: 0,
      stdout: "ok\n",
    });
    await provider.destroy({ lease });

    expect(lease).toMatchObject({
      externalSandboxId: "microvm_1",
      imageRef: "arn:aws:lambda:us-east-2:123456789012:microvm-image/agent@7",
      provider: "aws_lambda_microvm",
      reservedMemoryMiB: 4_096,
      reservedVcpu: 2,
      leaseExpiresAt: startedAt.getTime() + 3_600_000,
    });
    expect(commandInput(commands[0])).toMatchObject({
      clientToken: `lease-${ALLOCATION_ID}`,
      imageIdentifier: "arn:aws:lambda:us-east-2:123456789012:microvm-image/agent",
      imageVersion: "7",
    });
    expect(commandInput(commands[0])).not.toHaveProperty("idlePolicy");
    expect(commands.map(commandName)).toEqual(["RunMicrovmCommand", "TerminateMicrovmCommand"]);
    expect(requests).toEqual([
      "GET https://microvm-1.lambda-microvms.aws/__sandbox/health",
      "POST https://microvm-1.lambda-microvms.aws/__sandbox/exec",
    ]);
    expect(redirects).toEqual(["error", "error"]);
  });

  test("bounds every stage of Lambda MicroVM data-plane requests", async () => {
    const signals: AbortSignal[] = [];
    const provider = createLambdaMicrovmProvider({
      client: {
        async send(command, options) {
          if (options?.abortSignal) signals.push(options.abortSignal);
          if (commandName(command) === "GetMicrovmCommand") {
            return { endpoint: "microvm-timeout.lambda-microvms.aws" };
          }
          if (commandName(command) === "CreateMicrovmAuthTokenCommand") {
            return { authToken: { "X-aws-proxy-auth": "proxy-token" } };
          }
          throw new Error(`Unexpected command ${commandName(command)}`);
        },
      },
      fetch: async (_input, init) => {
        const signal = init?.signal;
        if (!signal) throw new Error("Expected a bounded Lambda control request");
        signals.push(signal);
        return new Response(
          new ReadableStream({
            start(controller) {
              signal.addEventListener("abort", () => controller.error(signal.reason), {
                once: true,
              });
            },
          }),
          { headers: { "content-type": "application/json" }, status: 200 },
        );
      },
      imageIdentifier: "arn:aws:lambda:us-east-2:123456789012:microvm-image/agent",
      requestTimeoutMs: 10,
    });
    const lease = {
      ...createInput,
      externalSandboxId: "microvm_timeout",
      provider: "aws_lambda_microvm" as const,
      status: "ready" as const,
    };

    expect(provider.exec({ command: ["pwd"], lease })).rejects.toBeDefined();
    expect(signals).toHaveLength(3);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(() =>
      createLambdaMicrovmProvider({
        imageIdentifier: "arn:aws:lambda:us-east-2:123456789012:microvm-image/agent",
        requestTimeoutMs: 0,
      }),
    ).toThrow("requestTimeoutMs must be a positive integer");
  });

  test("bounds Lambda MicroVM JSON and error response bodies", async () => {
    let lambdaBodyCancelled = false;
    const lambdaBodyChunk = new Uint8Array(1024 * 1024);
    let lambdaChunks = 0;
    const lambdaProvider = createLambdaMicrovmProvider({
      client: {
        async send(command) {
          if (commandName(command) === "GetMicrovmCommand") {
            return { endpoint: "microvm-large-response.lambda-microvms.aws" };
          }
          if (commandName(command) === "CreateMicrovmAuthTokenCommand") {
            return { authToken: { "X-aws-proxy-auth": "proxy-token" } };
          }
          throw new Error(`Unexpected command ${commandName(command)}`);
        },
      },
      fetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            cancel() {
              lambdaBodyCancelled = true;
            },
            pull(controller) {
              lambdaChunks += 1;
              controller.enqueue(lambdaBodyChunk);
              if (lambdaChunks === 51) controller.close();
            },
          }),
          { status: 200 },
        ),
      imageIdentifier: "lambda-image",
    });
    const lambdaLease = {
      ...createInput,
      externalSandboxId: "microvm_large_response",
      provider: "aws_lambda_microvm" as const,
      status: "ready" as const,
    };

    const lambdaError = await lambdaProvider
      .exec({ command: ["large-output"], lease: lambdaLease })
      .catch((error: unknown) => error);
    expect(lambdaError).toBeInstanceOf(SandboxDataPlaneUnknownError);
    expect(lambdaError).toMatchObject({
      cause: { message: "Sandbox JSON response exceeds 51380224 bytes" },
      operation: "exec",
    });
    expect(lambdaBodyCancelled).toBe(true);

    const oversizedError = `${"x".repeat(8_192)}tenant-secret-marker`;
    const errorProvider = createLambdaMicrovmProvider({
      client: lambdaProviderClient("microvm-oversized-error.lambda-microvms.aws"),
      fetch: async () => new Response(oversizedError, { status: 500 }),
      imageIdentifier: "lambda-image",
    });
    expect(errorProvider.exec({ command: ["fail"], lease: lambdaLease })).rejects.not.toThrow(
      "tenant-secret-marker",
    );
  });

  test("does not expose sandbox response bodies in transport errors", async () => {
    const secretBody = "credential=super-secret\n\u001b[31mforged-log-line";
    const lambdaProvider = createLambdaMicrovmProvider({
      client: {
        async send(command) {
          if (commandName(command) === "GetMicrovmCommand") {
            return { endpoint: "microvm-secret-error.lambda-microvms.aws" };
          }
          if (commandName(command) === "CreateMicrovmAuthTokenCommand") {
            return { authToken: { "X-aws-proxy-auth": "proxy-token" } };
          }
          throw new Error(`Unexpected command ${commandName(command)}`);
        },
      },
      fetch: async () => new Response(secretBody, { status: 400 }),
      imageIdentifier: "lambda-image",
    });
    const lambdaLease = {
      ...createInput,
      externalSandboxId: "microvm_secret_error",
      provider: "aws_lambda_microvm" as const,
      status: "ready" as const,
    };
    const lambdaError = await lambdaProvider
      .exec({ command: ["fail"], lease: lambdaLease })
      .catch((error: unknown) => error);

    expect((lambdaError as Error).message).not.toContain("super-secret");
    expect((lambdaError as Error).message).not.toContain("forged-log-line");
  });

  test("treats invalid successful exec payloads as ambiguous mutations", async () => {
    const lambdaProvider = createLambdaMicrovmProvider({
      client: {
        async send(command) {
          if (commandName(command) === "GetMicrovmCommand") {
            return { endpoint: "microvm-invalid-exec.lambda-microvms.aws" };
          }
          if (commandName(command) === "CreateMicrovmAuthTokenCommand") {
            return { authToken: { "X-aws-proxy-auth": "proxy-token" } };
          }
          throw new Error(`Unexpected command ${commandName(command)}`);
        },
      },
      fetch: async () => jsonResponse({ durationMs: -1, exitCode: 0 }),
      imageIdentifier: "lambda-image",
    });
    const lambdaLease = {
      ...createInput,
      externalSandboxId: "microvm_invalid_exec",
      provider: "aws_lambda_microvm" as const,
      status: "ready" as const,
    };
    const lambdaError = await lambdaProvider
      .exec({ command: ["invalid-result"], lease: lambdaLease })
      .catch((error: unknown) => error);

    expect(lambdaError).toBeInstanceOf(SandboxDataPlaneUnknownError);
    expect(lambdaError).toMatchObject({
      cause: { message: "Invalid sandbox exec.durationMs response" },
      operation: "exec",
    });
  });

  test("bounds Lambda MicroVM allocation and termination requests", async () => {
    let runAborted = false;
    const allocationProvider = createLambdaMicrovmProvider({
      allocationReconciliationAttempts: 1,
      client: {
        async send(command, options) {
          if (commandName(command) !== "RunMicrovmCommand") {
            throw new Error(`Unexpected command ${commandName(command)}`);
          }
          return await new Promise((_resolve, reject) => {
            options?.abortSignal?.addEventListener(
              "abort",
              () => {
                runAborted = true;
                reject(options.abortSignal?.reason);
              },
              { once: true },
            );
          });
        },
      },
      imageIdentifier: "lambda-image",
      requestTimeoutMs: 10,
    });

    expect(allocationProvider.create(createInput)).rejects.toBeInstanceOf(
      SandboxAllocationUnknownError,
    );
    expect(runAborted).toBe(true);

    let terminateAborted = false;
    const terminationProvider = createLambdaMicrovmProvider({
      client: {
        async send(command, options) {
          if (commandName(command) !== "TerminateMicrovmCommand") {
            throw new Error(`Unexpected command ${commandName(command)}`);
          }
          return await new Promise((_resolve, reject) => {
            options?.abortSignal?.addEventListener(
              "abort",
              () => {
                terminateAborted = true;
                reject(options.abortSignal?.reason);
              },
              { once: true },
            );
          });
        },
      },
      imageIdentifier: "lambda-image",
      requestTimeoutMs: 10,
    });

    expect(
      terminationProvider.destroy({
        lease: {
          ...createInput,
          externalSandboxId: "microvm_terminate_timeout",
          provider: "aws_lambda_microvm",
          status: "ready",
        },
      }),
    ).rejects.toBeInstanceOf(SandboxDestroyUnknownError);
    expect(terminateAborted).toBe(true);
  });

  test("classifies ambiguous data-plane mutations without retaining deterministic rejections", async () => {
    const lease = {
      ...createInput,
      externalSandboxId: "sandbox_data_plane_unknown",
      provider: "aws_lambda_microvm" as const,
      status: "ready" as const,
    };
    const deterministicLambda = createLambdaMicrovmProvider({
      client: lambdaProviderClient("microvm-data-plane.lambda-microvms.aws"),
      fetch: async () => jsonResponse({ message: "invalid command" }, { status: 400 }),
      imageIdentifier: "lambda-image",
    });
    expect(deterministicLambda.exec({ command: ["pwd"], lease })).rejects.not.toBeInstanceOf(
      SandboxDataPlaneUnknownError,
    );

    const ambiguousLambda = createLambdaMicrovmProvider({
      client: lambdaProviderClient("microvm-data-plane.lambda-microvms.aws"),
      fetch: async () => {
        throw new Error("response timeout");
      },
      imageIdentifier: "lambda-image",
    });
    expect(ambiguousLambda.exec({ command: ["pwd"], lease })).rejects.toBeInstanceOf(
      SandboxDataPlaneUnknownError,
    );
    expect(
      ambiguousLambda.upload({
        content: new Uint8Array([1]),
        lease,
        path: "/tmp/a",
      }),
    ).rejects.toBeInstanceOf(SandboxDataPlaneUnknownError);
  });
});
