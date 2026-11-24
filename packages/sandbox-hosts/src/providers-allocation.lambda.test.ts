import type { Ulid } from "@deployments-ai/db";
import { describe, expect, test } from "bun:test";
import {
  createLambdaMicrovmProvider,
  SandboxAllocationCleanupError,
  SandboxAllocationUnknownError,
} from "./index.ts";
import { ALLOCATION_ID, createInput } from "./providers-allocation.fixture.ts";

function commandName(command: unknown) {
  return (command as { constructor?: { name?: string } }).constructor?.name;
}

function commandInput(command: unknown) {
  return (command as { input?: unknown }).input;
}

function lambdaRunResult(endpoint: string, microvmId: string, maximumDurationInSeconds = 28_800) {
  return {
    endpoint,
    maximumDurationInSeconds,
    microvmId,
    startedAt: new Date("2026-07-21T00:00:00.000Z"),
  };
}

describe("sandbox provider allocation", () => {
  test("aborts hung Lambda readiness requests at the configured deadline", async () => {
    const commands: string[] = [];
    const provider = createLambdaMicrovmProvider({
      client: {
        async send(command) {
          const name = commandName(command) ?? "UnknownCommand";
          commands.push(name);
          if (name === "RunMicrovmCommand") {
            return lambdaRunResult("microvm-hung.lambda-microvms.aws", "microvm_hung");
          }
          if (name === "CreateMicrovmAuthTokenCommand") {
            return { authToken: { "X-aws-proxy-auth": "proxy-token" } };
          }
          if (name === "TerminateMicrovmCommand") return {};
          throw new Error(`Unexpected command ${name}`);
        },
      },
      fetch: async (_input, init) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          });
        }),
      imageIdentifier: "lambda-image",
      readinessIntervalMs: 1,
      readinessTimeoutMs: 10,
    });

    const failure = await provider.create(createInput).catch((error: unknown) => error);
    expect(failure).toMatchObject({
      cleanupCompletedAt: expect.any(Number),
      name: "SandboxAllocationLeaseError",
    });
    expect((failure as SandboxAllocationCleanupError).allocationError).toBeInstanceOf(Error);
    expect(((failure as SandboxAllocationCleanupError).allocationError as Error).message).toContain(
      "did not become ready within 10ms",
    );
    expect(commands).toEqual([
      "RunMicrovmCommand",
      "CreateMicrovmAuthTokenCommand",
      "TerminateMicrovmCommand",
    ]);
  });

  test("does not sleep past the Lambda readiness deadline", async () => {
    const provider = createLambdaMicrovmProvider({
      client: {
        async send(command) {
          const name = commandName(command);
          if (name === "RunMicrovmCommand") {
            return lambdaRunResult("microvm-deadline.lambda-microvms.aws", "microvm_deadline");
          }
          if (name === "CreateMicrovmAuthTokenCommand") {
            return { authToken: { "X-aws-proxy-auth": "proxy-token" } };
          }
          if (name === "TerminateMicrovmCommand") return {};
          throw new Error(`Unexpected command ${name}`);
        },
      },
      fetch: async () => new Response("not ready", { status: 503 }),
      imageIdentifier: "lambda-image",
      readinessIntervalMs: 1_000,
      readinessTimeoutMs: 10,
    });
    const startedAt = Date.now();

    expect(provider.create(createInput)).rejects.toBeDefined();

    expect(Date.now() - startedAt).toBeLessThan(250);
  });

  test("bounds Lambda auth-token discovery by the readiness deadline", async () => {
    const provider = createLambdaMicrovmProvider({
      client: {
        async send(command, options) {
          const name = commandName(command);
          if (name === "RunMicrovmCommand") {
            return lambdaRunResult("microvm-auth-hung.lambda-microvms.aws", "microvm_auth_hung");
          }
          if (name === "CreateMicrovmAuthTokenCommand") {
            return await new Promise((_resolve, reject) => {
              options?.abortSignal?.addEventListener(
                "abort",
                () => reject(options.abortSignal?.reason),
                { once: true },
              );
            });
          }
          if (name === "TerminateMicrovmCommand") return {};
          throw new Error(`Unexpected command ${name}`);
        },
      },
      imageIdentifier: "lambda-image",
      readinessIntervalMs: 1,
      readinessTimeoutMs: 10,
    });
    const startedAt = Date.now();

    expect(provider.create(createInput)).rejects.toBeDefined();

    expect(Date.now() - startedAt).toBeLessThan(250);
  });

  test("surfaces the allocated MicroVM identity when readiness cleanup fails", async () => {
    const provider = createLambdaMicrovmProvider({
      client: {
        async send(command) {
          const name = commandName(command);
          if (name === "RunMicrovmCommand") {
            return lambdaRunResult("microvm-leaked.lambda-microvms.aws", "microvm_leaked");
          }
          if (name === "CreateMicrovmAuthTokenCommand") {
            return { authToken: { "X-aws-proxy-auth": "proxy-token" } };
          }
          if (name === "TerminateMicrovmCommand") throw new Error("terminate denied");
          throw new Error(`Unexpected command ${name}`);
        },
      },
      fetch: async () => new Response("not ready", { status: 503 }),
      imageIdentifier: "lambda-image",
      readinessIntervalMs: 1,
      readinessTimeoutMs: 1,
    });

    try {
      await provider.create(createInput);
      throw new Error("Expected Lambda allocation cleanup to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(SandboxAllocationCleanupError);
      expect((error as SandboxAllocationCleanupError).lease.externalSandboxId).toBe(
        "microvm_leaked",
      );
    }
  });

  test("uses the persisted lease ID as the Lambda allocation token", async () => {
    const commands: unknown[] = [];
    const provider = createLambdaMicrovmProvider({
      client: {
        async send(command) {
          if (commandName(command) === "CreateMicrovmAuthTokenCommand") {
            return { authToken: { "X-aws-proxy-auth": "proxy-token" } };
          }
          commands.push(command);
          return lambdaRunResult(
            `microvm-${commands.length}.lambda-microvms.aws`,
            `microvm_${commands.length}`,
          );
        },
      },
      fetch: async () => new Response(null, { status: 204 }),
      imageIdentifier: "lambda-image",
      readinessTimeoutMs: 100,
    });
    const secondAllocationId = "01ARZ3NDEKTSV4RRFFQ69G5FB1" as Ulid;

    await provider.create(createInput);
    await provider.create({ ...createInput, allocationId: secondAllocationId });

    expect(
      commands.map((command) => (commandInput(command) as { clientToken: string }).clientToken),
    ).toEqual([`lease-${ALLOCATION_ID}`, `lease-${secondAllocationId}`]);
  });

  test("retries ambiguous Lambda allocation responses with the same token", async () => {
    const tokens: string[] = [];
    const provider = createLambdaMicrovmProvider({
      allocationReconciliationAttempts: 3,
      client: {
        async send(command) {
          if (commandName(command) === "CreateMicrovmAuthTokenCommand") {
            return { authToken: { "X-aws-proxy-auth": "proxy-token" } };
          }
          tokens.push((commandInput(command) as { clientToken: string }).clientToken);
          if (tokens.length < 3) throw new Error("response timeout");
          return lambdaRunResult("microvm-reconciled.lambda-microvms.aws", "microvm_reconciled");
        },
      },
      fetch: async () => new Response(null, { status: 204 }),
      imageIdentifier: "lambda-image",
      readinessTimeoutMs: 100,
    });

    expect(provider.create(createInput)).resolves.toMatchObject({
      externalSandboxId: "microvm_reconciled",
    });
    expect(tokens).toEqual([
      `lease-${ALLOCATION_ID}`,
      `lease-${ALLOCATION_ID}`,
      `lease-${ALLOCATION_ID}`,
    ]);
  });

  test("does not mark deterministic Lambda service rejections as ambiguous", async () => {
    let runCalls = 0;
    const denied = Object.assign(new Error("not authorized"), {
      $fault: "client",
      $metadata: { httpStatusCode: 403 },
    });
    const provider = createLambdaMicrovmProvider({
      allocationReconciliationAttempts: 3,
      client: {
        async send() {
          runCalls += 1;
          throw denied;
        },
      },
      imageIdentifier: "lambda-image",
      readinessTimeoutMs: 1,
    });

    expect(provider.create(createInput)).rejects.toBe(denied);
    expect(runCalls).toBe(1);
  });

  test("retries ambiguous Lambda request-timeout responses", async () => {
    let runCalls = 0;
    const provider = createLambdaMicrovmProvider({
      allocationReconciliationAttempts: 2,
      client: {
        async send(command) {
          if (commandName(command) === "CreateMicrovmAuthTokenCommand") {
            return { authToken: { "X-aws-proxy-auth": "proxy-token" } };
          }
          if (commandName(command) !== "RunMicrovmCommand") {
            throw new Error(`Unexpected command ${commandName(command)}`);
          }
          runCalls += 1;
          if (runCalls === 1) {
            throw Object.assign(new Error("request timeout"), {
              $fault: "client",
              $metadata: { httpStatusCode: 408 },
            });
          }
          return lambdaRunResult("microvm-timeout.lambda-microvms.aws", "microvm_timeout");
        },
      },
      fetch: async () => new Response(null, { status: 204 }),
      imageIdentifier: "lambda-image",
      readinessTimeoutMs: 100,
    });

    expect(provider.create(createInput)).resolves.toMatchObject({
      externalSandboxId: "microvm_timeout",
    });
    expect(runCalls).toBe(2);
  });

  test("terminates Lambda allocations whose endpoint response cannot be parsed", async () => {
    const commands: string[] = [];
    const provider = createLambdaMicrovmProvider({
      client: {
        async send(command) {
          const name = commandName(command) ?? "UnknownCommand";
          commands.push(name);
          if (name === "RunMicrovmCommand") {
            return {
              endpoint: "http://microvm-bad-endpoint.lambda-microvms.aws",
              maximumDurationInSeconds: 28_800,
              microvmId: "microvm_bad_endpoint",
              startedAt: new Date("2026-07-21T00:00:00.000Z"),
            };
          }
          if (name === "TerminateMicrovmCommand") return {};
          throw new Error(`Unexpected command ${name}`);
        },
      },
      imageIdentifier: "lambda-image",
      readinessTimeoutMs: 1,
    });

    expect(provider.create(createInput)).rejects.toMatchObject({
      cleanupCompletedAt: expect.any(Number),
      lease: {
        externalSandboxId: "microvm_bad_endpoint",
        provider: "aws_lambda_microvm",
        reservedMemoryMiB: 2_048,
        reservedVcpu: 1,
      },
      name: "SandboxAllocationLeaseError",
    });
    expect(commands).toEqual(["RunMicrovmCommand", "TerminateMicrovmCommand"]);
  });

  test("treats missing Lambda allocations as successfully cleaned after create", async () => {
    const provider = createLambdaMicrovmProvider({
      client: {
        async send(command) {
          const name = commandName(command);
          if (name === "RunMicrovmCommand") {
            return {
              endpoint: "http://microvm-missing.lambda-microvms.aws",
              maximumDurationInSeconds: 28_800,
              microvmId: "microvm_missing_after_create",
              startedAt: new Date("2026-07-21T00:00:00.000Z"),
            };
          }
          if (name === "TerminateMicrovmCommand") {
            throw { name: "ResourceNotFoundException" };
          }
          throw new Error(`Unexpected command ${name}`);
        },
      },
      imageIdentifier: "lambda-image",
      readinessTimeoutMs: 1,
    });

    expect(provider.create(createInput)).rejects.toMatchObject({
      cleanupCompletedAt: expect.any(Number),
      lease: { externalSandboxId: "microvm_missing_after_create" },
      name: "SandboxAllocationLeaseError",
    });
  });

  test("keeps malformed Lambda allocation identities reconcilable", async () => {
    const provider = createLambdaMicrovmProvider({
      client: {
        async send(command) {
          if (commandName(command) === "RunMicrovmCommand") {
            return { maximumDurationInSeconds: 28_800, startedAt: new Date() };
          }
          throw new Error(`Unexpected command ${commandName(command)}`);
        },
      },
      imageIdentifier: "lambda-image",
      reconciliationTarget: "lambda-target",
    });

    const error = await provider.create(createInput).catch((cause) => cause);
    expect(error).toBeInstanceOf(SandboxAllocationUnknownError);
    expect(error.allocationToken).toBe(`lease-${createInput.allocationId}`);
    expect(error.automaticReconciliation).toBe(true);
  });
});
